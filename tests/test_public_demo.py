"""Exercise guest demo boundaries and the actual navigation/settings event handlers."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from starlette.requests import Request
from test_demo_provider import handlers, request, DEMO
from uni_app import ai_provider

ROOT = Path(__file__).parents[1]
TREE = ast.parse((ROOT/'uni_app/uni_app.py').read_text())
STATE = next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='AppState')

def extracted(name, ns=None, state=False):
    fn=next(n for n in (STATE.body if state else TREE.body) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name)
    fn=ast.parse(ast.unparse(fn)).body[0];fn.decorator_list=[]
    scope={} if ns is None else ns
    exec(compile(ast.Module(body=[fn],type_ignores=[]),'actual-demo-handler','exec'),scope)
    return scope[name]

def voice_scope(demo=True):
    sessions={'guest-session-key':{'uid':1500000100,'anonymous':True,'_created':1000},
              'account-session-key':{'uid':42,'anonymous':False,'_created':1000},
              'other-guest-key':{'uid':1500000200,'anonymous':True,'_created':1000}}
    scope={'AI_CONFIG':SimpleNamespace(demo=demo),'_alex_voice_sessions':sessions,
           '_uid_from_auth_token':lambda t:42 if t=='valid-account' else -1,
           '_is_valid_voice_key':lambda k:bool(k) and len(k)>=10,
           'time':SimpleNamespace(time=lambda:1100),'VOICE_SESSION_MAX_AGE_SEC':3600,'Request':Request}
    return scope, extracted('_voice_request_uid',scope)

def voice_request(key=None, token=None):
    headers=[]
    if key:headers.append((b'x-alex-voice-key',key.encode()))
    if token:headers.append((b'x-auth-token',token.encode()))
    return Request({'type':'http','headers':headers,'query_string':b''})

class PublicDemoTests(unittest.TestCase):
    def test_voice_requires_server_issued_guest_capability_and_demo_flag(self):
        ns,resolve=voice_scope()
        self.assertEqual(resolve(voice_request('guest-session-key')),1500000100)
        for key in (None,'not-issued-key','account-session-key'):
            self.assertEqual(resolve(voice_request(key)),-1)
        ns['AI_CONFIG'].demo=False
        self.assertEqual(resolve(voice_request('guest-session-key')),-1)

    def test_account_auth_is_authoritative_and_expired_guest_key_is_rejected(self):
        ns,resolve=voice_scope()
        self.assertEqual(resolve(voice_request('guest-session-key','valid-account')),42)
        self.assertEqual(resolve(voice_request('guest-session-key','expired-account')),-1)
        ns['_alex_voice_sessions']['guest-session-key']['_created']=-5000
        self.assertEqual(resolve(voice_request('guest-session-key')),-1)

    def test_guest_cannot_use_an_account_or_another_guests_voice_context(self):
        ns=handlers();auth,resolve=voice_scope();ns['_voice_request_uid']=resolve
        ns['_alex_voice_sessions']={**auth['_alex_voice_sessions']}
        for key in ('account-session-key','other-guest-key'):
            req=request(('{'+'"transcript":"Hello","voice_key":"'+key+'"}').encode())
            req.scope['headers'].append((b'x-alex-voice-key',b'guest-session-key'))
            response=asyncio.run(ns['alex_voice_api'](req))
            self.assertEqual(response.status_code,403)

    def test_guest_stt_uses_groq_without_account_auth(self):
        ns=handlers();_,resolve=voice_scope();ns['_voice_request_uid']=resolve
        async def transcribe(*args):return 'Hello Alex'
        original=ai_provider.transcribe;ai_provider.transcribe=transcribe
        try:
            req=request(b'valid-audio'*20,'audio/mp4')
            req.scope['headers'].append((b'x-alex-voice-key',b'guest-session-key'))
            result=asyncio.run(ns['alex_voice_stt'](req))
            self.assertEqual(result.status_code,200)
            self.assertIn(b'Hello Alex',result.body)
        finally:ai_provider.transcribe=original

    def test_settings_guest_opens_without_loading_private_profile(self):
        profile=Mock(side_effect=AssertionError('private profile accessed'))
        self_state=SimpleNamespace(_uid=lambda:-1,_active_data_uid=lambda:1500000100,
                                  _load_guest_memory=Mock(),_initialize_public_demo=Mock(),
                                  _load_profile=profile,name='Visitor')
        fn=extracted('on_load_settings',{'AI_CONFIG':DEMO,'PLAN_FREE':'free','rx':SimpleNamespace(redirect=Mock()),'auth_routes':SimpleNamespace(LOGIN_ROUTE='/login')},True)
        self.assertIsNone(fn(self_state));self.assertEqual(self_state._cached_uid,-1)
        self.assertEqual(self_state.user_unique_id,'');profile.assert_not_called()
        self_state._load_guest_memory.assert_called_once_with(1500000100)

    def test_authenticated_settings_loads_own_profile(self):
        own=SimpleNamespace(_uid=lambda:42,_load_profile=Mock(),name='Student')
        extracted('on_load_settings',{'AI_CONFIG':DEMO,'PLAN_FREE':'free'},True)(own)
        own._load_profile.assert_called_once_with(42);self.assertEqual(own._cached_uid,42)

    def test_private_account_writes_recheck_auth_not_cached_id(self):
        state=SimpleNamespace(_cached_uid=42,_uid=lambda:-1,settings_delete_confirm='DELETE')
        # No rx/session namespace is provided: unauthenticated calls must return before DB access.
        extracted('settings_delete_account',{},True)(state)
        extracted('settings_change_password',{},True)(state)
        self.assertEqual(state.settings_pw_error,'Not authenticated.')

    def test_foreign_chat_id_is_rejected_before_any_message_query(self):
        state=SimpleNamespace(active_scope='home',current_session_id='42',current_session_choice='42',
                              chat_history=[{'role':'assistant','content':'stale'}],
                              _clear_canvas_state=Mock(),_session_in_scope=Mock(return_value=False))
        # No database globals: a rejected foreign ID must never reach a DB query.
        extracted('_load_messages',{},True)(state,1500000100,'home')
        state._session_in_scope.assert_called_once_with(1500000100,42,'home')
        self.assertEqual(state.chat_history,[]);self.assertEqual(state.current_session_id,'')

    def test_guest_defaults_have_no_claimed_progress_or_fake_auth(self):
        state=SimpleNamespace(_uid=lambda:-1,is_started=False,_save_memory=Mock())
        extracted('_initialize_public_demo',{'AI_CONFIG':DEMO},True)(state,1500000100)
        self.assertEqual(state.name,'Visitor');self.assertTrue(state.is_started)
        self.assertIn('No prior achievements',state.memory_summary)
        self.assertFalse(hasattr(state,'_cached_uid'));state._save_memory.assert_called_once_with(1500000100)

    def test_growth_click_on_home_changes_mode_without_replacing_history(self):
        history=[{'role':'user','content':'Learning loops'}]
        state=SimpleNamespace(_active_data_uid=lambda:1500000100,active_scope='home',view_mode='home',chat_history=history)
        rx=SimpleNamespace(toast=SimpleNamespace(info=lambda text:('notice',text)))
        fn=extracted('go_home',{'rx':rx},True)
        async def collect():return [event async for event in fn(state)]
        events=asyncio.run(collect());self.assertTrue(state.growth_mode)
        self.assertEqual(len(events),1);self.assertIs(state.chat_history,history)

    def test_app_entry_opens_guest_workspace_before_hydration_without_login(self):
        state=SimpleNamespace(_uid=lambda:-1,is_hydrated=False,_active_data_uid=lambda:1500000100,
                              _load_guest_memory=Mock(),_initialize_public_demo=Mock(),_workspace_home_route=lambda:'/s/home')
        fn=extracted('on_load',{'AI_CONFIG':DEMO,'rx':SimpleNamespace(redirect=lambda route:route)},True)
        async def collect():return [event async for event in fn(state)]
        self.assertEqual(asyncio.run(collect()),['/s/home'])
        self.assertEqual(state._cached_uid,-1)
        state._initialize_public_demo.assert_called_once_with(1500000100)

    def test_guest_tracker_storage_does_not_mark_visitor_authenticated(self):
        import contextlib
        tracker=next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='TrackerState')
        fn=next(n for n in tracker.body if isinstance(n,ast.FunctionDef) and n.name=='on_load_tracker')
        ns={'rx':SimpleNamespace(session=lambda:contextlib.nullcontext(object()))}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'tracker-demo','exec'),ns)
        state=SimpleNamespace(_uid=lambda:-1,_active_data_uid=lambda:1500000100,_load_guest_memory=Mock(),
                              _load_lists=Mock(),current_tracker_id=-1,tracker_lists=[])
        ns['on_load_tracker'](state)
        self.assertEqual(state._cached_uid,-1);self.assertEqual(state._tracker_data_uid,1500000100)

    def test_growth_prompt_retains_existing_scope_context_and_anonymous_honesty(self):
        source=ast.unparse(next(n for n in STATE.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='send_message'))
        self.assertIn('_degree_is_custom(self.degree) and (not self.growth_mode)',source)
        self.assertIn('central academic growth assistant',source)
        self.assertIn('No prior completed topics, achievements',source)
        self.assertIn('cross_semester_scope_digest',source)

    def test_header_actions_are_in_flow_and_account_content_is_guarded_in_both_layouts(self):
        guest=ast.unparse(next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='guest_auth_buttons'))
        self.assertNotIn("position='fixed'",guest);self.assertIn("flex_wrap='wrap'",guest)
        settings=ast.unparse(next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='settings_page'))
        self.assertEqual(settings.count('AppState.is_authenticated_now, settings_account_tab()'),2)
