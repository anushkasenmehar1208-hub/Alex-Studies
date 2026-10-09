"""Exercise actual pathway parsing, existing curriculum and cached Day 1 plans."""
import ast
import json
import re
from pathlib import Path
import typing
import unittest

ROOT = Path(__file__).parents[1]
TREE = ast.parse((ROOT/'uni_app/uni_app.py').read_text())
NAMES = {'KELANIYA_SCIENCE_HANDBOOK_URL','KELANIYA_PS_CURRICULUM','KELANIYA_BS_CURRICULUM',
         'KELANIYA_BECS_CURRICULUM','BECS_CURRICULUM','PS_SUBJECT_CURRICULUM','BS_SUBJECT_CURRICULUM',
         'PS_SUBJECT_FULL_NAMES','BS_SUBJECT_FULL_NAMES','PS_PATHWAYS','BS_PATHWAYS',
         'DEGREE_PATHWAYS','DEGREE_SUBJECT_FULL_NAMES','DEGREE_SUBJECT_CURRICULUM',
         'DEGREE_CURRICULUM_UNITS','MULTI_SUBJECT_DEGREES'}
FUNCTIONS = {'_course_unit','pathway_subject_codes','canonical_pathway_label','_pregenerated_plan_filename'}
ns={'Any':typing.Any}
selected=[]
for node in TREE.body:
    if isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name) and node.target.id in NAMES:
        selected.append(node)
    elif isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in NAMES for t in node.targets):
        selected.append(node)
    elif isinstance(node,ast.FunctionDef) and node.name in FUNCTIONS:
        selected.append(node)
exec(compile(ast.Module(body=selected,type_ignores=[]),'actual-curriculum','exec'),ns)
ns['FLAT_DEGREE_CURRICULUM']={'Electronics and Computer Science (BECS)':ns['BECS_CURRICULUM']}
APP=next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='AppState')
METHODS={'_is_multi_subject_degree','_pathway_subjects','_multi_subject_course_table','_multi_subject_unit_table',
         '_multi_subject_full_names','_semester_courses','_semester_courses_for_subject',
         '_semester_course_units_for_subject','_semester_course_units','_all_semester_courses_ps',
         '_has_curriculum_for_semester','_active_subject_for_semester','_other_subjects',
         'subject_switcher_options'}
body=[]
for node in APP.body:
    if isinstance(node,ast.FunctionDef) and node.name in METHODS:
        node=ast.parse(ast.unparse(node)).body[0];node.decorator_list=[];body.append(node)
cls=ast.ClassDef(name='ActualState',bases=[],keywords=[],body=body,decorator_list=[])
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),'actual-state', 'exec'),ns)

class PathwayCurriculumTests(unittest.TestCase):
    def state(self,pathway,degree='Physical Science'):
        s=ns['ActualState']();s.degree=degree;s.pathway=pathway;s.active_subject=''
        s._subject_scope_preferences=lambda:{}
        s._base_semester_scope=lambda y,sem:'y1s1'
        return s

    def test_next_onboarding_full_names_match_all_ten_existing_pathways(self):
        page=(ROOT/'next-app/src/app/onboarding/page.tsx').read_text()
        section=page.split('const PS_PATHWAYS:',1)[1].split('const BS_PATHWAYS:',1)[0]
        labels=re.findall(r'code: "([^"]+)"',section)
        self.assertEqual(len(labels),len(ns['PS_PATHWAYS']))
        for label,codes in zip(labels,ns['PS_PATHWAYS']):
            with self.subTest(codes=codes):
                self.assertEqual(ns['pathway_subject_codes'](label),codes)
                self.assertEqual(ns['canonical_pathway_label']('Physical Science',label),' / '.join(codes))
                s=self.state(label)
                s.active_subject=s._active_subject_for_semester('Year 1','Semester 1')
                self.assertEqual(s.active_subject,codes[0])
                self.assertTrue(s._has_curriculum_for_semester('Year 1','Semester 1'))

    def test_each_pathway_subject_switches_to_its_own_existing_courses_and_day_one(self):
        for codes in ns['PS_PATHWAYS']:
            s=self.state(' / '.join(ns['PS_SUBJECT_FULL_NAMES'][c] for c in codes))
            for code in codes:
                with self.subTest(pathway=codes,subject=code):
                    s.active_subject=code
                    courses=s._semester_courses('Year 1','Semester 1')
                    self.assertTrue(courses)
                    self.assertTrue(all(c.startswith(code+':') for c in courses))
                    self.assertTrue(s._semester_course_units('Year 1','Semester 1'))
                    self.assertEqual({o['code'] for o in s.subject_switcher_options()},set(codes)-{code})
                    filename=ns['_pregenerated_plan_filename']('Physical Science','y1s1',code)
                    plan=json.loads((ROOT/'uni_app/pregenerated_plans'/filename).read_text())
                    self.assertTrue(plan)
                    self.assertTrue(plan[0].get('topics'))

    def test_existing_codes_mixed_labels_and_biological_pathways_are_preserved(self):
        parse=ns['pathway_subject_codes']
        self.assertEqual(parse('COSC / PHYS / PMAT'),['COSC','PHYS','PMAT'])
        self.assertEqual(parse('Computer Science / PHYS / Pure Mathematics'),['COSC','PHYS','PMAT'])
        self.assertEqual(parse(' computer science / physics / pure mathematics '),['COSC','PHYS','PMAT'])
        self.assertEqual(parse('Plant Biology-Chemistry-Zoology'),['PLBL','CHEM','ZOOL'])
        self.assertEqual(parse('PLBL-CHEM-ZOOL'),['PLBL','CHEM','ZOOL'])
        self.assertEqual(parse('Unknown Subject / PHYS'),['Unknown Subject','PHYS'])
        self.assertEqual(parse(''),[])

    def test_combined_electronics_computer_science_degree_keeps_flat_curriculum(self):
        s=self.state('', 'Electronics and Computer Science (BECS)')
        self.assertFalse(s._is_multi_subject_degree())
        courses=s._semester_courses('Year 1','Semester 1')
        self.assertEqual(courses,ns['BECS_CURRICULUM']['Year 1']['Semester 1'])
        self.assertTrue(courses)
        self.assertTrue(s._semester_course_units('Year 1','Semester 1'))
        filename=ns['_pregenerated_plan_filename'](s.degree,'y1s1')
        plan=json.loads((ROOT/'uni_app/pregenerated_plans'/filename).read_text())
        self.assertTrue(plan[0].get('topics'))

if __name__=='__main__':unittest.main()
