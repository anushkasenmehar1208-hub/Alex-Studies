"""Execute actual Learn handlers with isolated state/provider/DB doubles (no network)."""
import ast
import asyncio
from collections import defaultdict
import json
import logging
from pathlib import Path
import re
from types import SimpleNamespace
import threading
import time
import unittest
from unittest.mock import Mock

TREE = ast.parse((Path(__file__).parents[1] / 'uni_app/uni_app.py').read_text())
LEARN = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == 'LearnState')

def extract(name, scope, owner=LEARN):
    node = next(n for n in owner.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name)
    node = ast.parse(ast.unparse(node)).body[0]
    if not isinstance(node, ast.ClassDef): node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'actual-learn-handler', 'exec'), scope)
    return scope[name]

class State(SimpleNamespace):
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass

class LearnDemoTests(unittest.TestCase):
    def scope(self, demo=True):
        scope = {'asyncio': asyncio, 'json': json, 're': re, 'logger': logging.getLogger('learn-test'),
                 'AI_CONFIG': SimpleNamespace(uses_groq=demo), 'LEARN_DEMO_ACCESS': demo,
                 'OPENROUTER_TEACHER_MODEL': 'paid-model', 'youtube_utils': SimpleNamespace(truncate_for_llm=lambda t, n: t[:n]),
                 '_threading': threading, '_defaultdict': defaultdict, 'time': time}
        limiter = extract('_RateLimiter', scope, TREE)()
        scope['_rl'] = limiter
        scope['_learn_generation_limit'] = extract('_learn_generation_limit', scope, TREE)
        scope['_openrouter_complete'] = Mock(return_value=SimpleNamespace(text='# TL;DR\nTranscript-based guide'))
        return scope

    def state(self, access=True):
        return State(has_learning_access=access, has_premium_access=False, summary_loading=False, quiz_loading=False,
                     video_id='abcdefghijk', session_id=1, transcript='Photosynthesis converts sunlight into stored chemical energy.',
                     has_transcript=True, summary='', quiz_questions=[], quiz_revealed=False,
                     rate_limit_msg='', _active_data_uid=lambda:1500000100, _persist_session=Mock())

    def test_policy_is_server_demo_flag_and_has_no_client_setter(self):
        source = ast.unparse(TREE)
        self.assertIn("AI_CONFIG.demo and os.getenv('ALEX_LEARN_DEMO_ACCESS'", source)
        getter = extract('has_learning_access', self.scope())
        self.assertTrue(getter(SimpleNamespace(has_premium_access=False)))
        ns = self.scope(False)
        getter = extract('has_learning_access', ns)
        self.assertFalse(getter(SimpleNamespace(has_premium_access=False)))
        self.assertTrue(getter(SimpleNamespace(has_premium_access=True)))
        self.assertNotIn('set_has_learning_access', source)

    def test_guest_guide_grounds_existing_structured_prompt_and_uses_groq_wrapper(self):
        ns=self.scope(); state=self.state()
        asyncio.run(extract('generate_summary', ns)(state))
        args, kwargs = ns['_openrouter_complete'].call_args
        self.assertIn('TL;DR', args[1][0]['content'])
        self.assertIn(state.transcript, args[1][1]['content'])
        self.assertTrue(kwargs['raise_errors'])
        self.assertTrue(state.summary.startswith('# TL;DR'))
        state._persist_session.assert_called_once_with(summary=True)

    def test_authenticated_premium_generation_keeps_non_demo_behavior(self):
        ns=self.scope(False);state=self.state();state.has_premium_access=True
        asyncio.run(extract('generate_summary',ns)(state))
        self.assertTrue(state.summary)
        self.assertFalse(ns['_openrouter_complete'].call_args.kwargs['raise_errors'])

    def test_locked_mode_or_failed_transcript_never_calls_provider(self):
        for access, transcript in ((False,True),(True,False)):
            ns=self.scope();state=self.state(access);state.has_transcript=transcript
            for name in ('generate_summary','generate_quiz'):
                asyncio.run(extract(name,ns)(state))
            ns['_openrouter_complete'].assert_not_called()

    def test_quiz_answer_and_reveal_preserve_existing_scoring(self):
        ns=self.scope();state=self.state()
        question={'q':'What supplies energy?', 'choices':['Sunlight','Sand','Wind','Rock'], 'answer':0,'explain':'Sunlight powers photosynthesis.'}
        ns['_openrouter_complete'].return_value.text=json.dumps({'questions':[question]*5})
        asyncio.run(extract('generate_quiz',ns)(state))
        self.assertEqual(len(state.quiz_questions),5)
        self.assertIn(state.transcript, ns['_openrouter_complete'].call_args.args[1][1]['content'])
        extract('quiz_pick',ns)(state,0,0)
        extract('quiz_reveal',ns)(state)
        self.assertTrue(state.quiz_revealed)
        self.assertEqual(extract('quiz_score',ns)(state),'1/5')
        extract('quiz_pick',ns)(state,0,9)
        self.assertEqual(state.quiz_questions[0]['picked'],0)

    def test_invalid_json_and_provider_errors_are_not_cached_or_leaked(self):
        for name in ('generate_summary','generate_quiz'):
            ns=self.scope();state=self.state();ns['_openrouter_complete'].side_effect=RuntimeError('secret-provider-detail')
            asyncio.run(extract(name,ns)(state))
            self.assertNotIn('secret-provider-detail',state.rate_limit_msg)
            self.assertTrue(state.rate_limit_msg)
            state._persist_session.assert_not_called()
            self.assertFalse(state.summary_loading or state.quiz_loading)
        ns=self.scope();state=self.state();ns['_openrouter_complete'].return_value.text='not JSON'
        asyncio.run(extract('generate_quiz',ns)(state))
        self.assertTrue(state.rate_limit_msg);state._persist_session.assert_not_called()

    def test_combined_user_quota_cooldown_global_cap_and_paid_mode(self):
        ns=self.scope();limit=ns['_learn_generation_limit'];rl=ns['_rl']
        self.assertEqual(limit(1500000100),'')
        self.assertTrue(limit(1500000100))
        rl._counts.clear()
        rl._counts['learn-demo:1500000100']=[time.time()]*6
        self.assertTrue(limit(1500000100))
        rl._counts.clear();rl._counts['learn-demo-global']=[time.time()]*60
        self.assertTrue(limit(1500000200))
        ns['LEARN_DEMO_ACCESS']=False
        self.assertEqual(limit(1500000200),'')

    def test_stale_video_result_is_not_saved_in_new_session(self):
        ns=self.scope();state=self.state()
        def completion(*a,**kw):
            state.video_id='differentid'; return SimpleNamespace(text='Old video guide')
        ns['_openrouter_complete'].side_effect=completion
        asyncio.run(extract('generate_summary',ns)(state))
        self.assertEqual(state.summary,'');state._persist_session.assert_not_called()

    def test_session_writes_recheck_guest_ownership_and_video(self):
        for fn in ('_persist_session','_persist_session_transcript'):
            for owner,video in ((42,'abcdefghijk'),(1500000200,'abcdefghijk'),(1500000100,'other-video')):
                ns=self.scope(); state=self.state(); row=SimpleNamespace(user_id=owner,video_id=video)
                db=Mock();db.get.return_value=row
                class Context:
                    def __enter__(self):return db
                    def __exit__(self,*a):pass
                ns.update(rx=SimpleNamespace(session=Context),LearnVideoSession=object)
                kwargs={'summary':True} if fn=='_persist_session' else {}
                extract(fn,ns)(state,**kwargs)
                db.commit.assert_not_called()

    def test_ui_lock_and_onboarding_gate_use_same_policy(self):
        text=ast.unparse(TREE)
        panel=ast.unparse(next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='_learn_paid_panel'))
        tab=ast.unparse(next(n for n in TREE.body if isinstance(n,ast.FunctionDef) and n.name=='_learn_tab_button'))
        self.assertIn('LearnState.has_learning_access',panel)
        self.assertIn('LearnState.has_learning_access',tab)
        load=ast.unparse(next(n for n in LEARN.body if isinstance(n,ast.FunctionDef) and n.name=='on_load_learn'))
        self.assertIn('not self.is_started and (not LEARN_DEMO_ACCESS)',load)

if __name__=='__main__':unittest.main()
