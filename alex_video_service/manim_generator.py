"""LLM-driven recipe generator → composes premium Manim videos from templates.

Pipeline:
  1. Validate topic (profanity / gibberish guard)
  2. Ask LLM for a JSON recipe + narration text
  3. Compose recipe → full Manim scene code
  4. Return (narration_text, scene_code) — renderer takes it from here
"""

from __future__ import annotations

import json
import os
import re
import textwrap

import httpx

from composer import RecipeError, compose_scene
from templates import TEMPLATES, get_template_catalog, list_template_names

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "openai/gpt-4o"


# ──────────────────────────────────────────────────────────────────────────
# Topic validation (profanity / gibberish)
# ──────────────────────────────────────────────────────────────────────────

_PROFANITY = {
    "fuck", "fucking", "fucked", "fucker", "shit", "shitting", "shitty",
    "bitch", "bitches", "bastard", "asshole", "ass", "arse", "damn",
    "cunt", "dick", "cock", "pussy", "piss", "pissed", "crap",
    "nigger", "nigga", "faggot", "fag", "slut", "whore", "porn",
    "sex", "naked", "nude", "rape", "kill", "murder", "suicide",
    "terrorist", "bomb", "drug", "drugs", "cocaine", "heroin", "meth",
    "weed", "cannabis",
}


def _is_gibberish(word: str) -> bool:
    if len(word) <= 2:
        return False
    vowels = set("aeiouAEIOU")
    vowel_count = sum(c in vowels for c in word)
    if len(word) > 4 and vowel_count / len(word) < 0.15:
        return True
    consonants_run = max(
        (len(m.group()) for m in re.finditer(r"[^aeiouAEIOU\W\d_]+", word)),
        default=0,
    )
    return consonants_run >= 5


def validate_topic(topic: str) -> None:
    """Raise GenerationError if topic is inappropriate or gibberish."""
    stripped = topic.strip()
    if not stripped:
        raise GenerationError("Please enter a topic.")

    words = re.findall(r"[a-zA-Z]+", stripped)
    for w in words:
        if w.lower() in _PROFANITY:
            raise GenerationError(
                "Topic contains inappropriate content. "
                "Please enter an educational topic (e.g. Quantum Mechanics, Black Holes, DNA)."
            )

    alpha_chars = sum(c.isalpha() for c in stripped)
    if len(stripped) > 0 and alpha_chars / len(stripped) < 0.4:
        raise GenerationError(
            "Topic looks like random characters. "
            "Please enter a real subject (e.g. Calculus, The French Revolution, Photosynthesis)."
        )

    if words:
        gibberish_count = sum(1 for w in words if _is_gibberish(w))
        if gibberish_count / len(words) >= 0.6:
            raise GenerationError(
                "Topic doesn't look like a real subject. "
                "Please enter something educational (e.g. Machine Learning, Roman Empire, Relativity)."
            )


class GenerationError(RuntimeError):
    pass


# ──────────────────────────────────────────────────────────────────────────
# LLM prompt
# ──────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = textwrap.dedent(
    r"""
    You are a master science teacher who DESIGNS educational videos in the style
    of 3Blue1Brown / Khan Academy. You write 4 custom Manim animation scenes per
    video that genuinely TEACH the concept — not decorate, TEACH.

    ━━━ HOW IT WORKS ━━━
    Each video has 6 scenes. YOU design ALL 6 — every single one is custom
    Manim code you write. No templates. Every visual must be topic-specific.
    The wrapper automatically adds the heading + subtext text on screen,
    and automatically fades everything out at the end of each scene — DON'T
    add your own FadeOut at the end of the body, the wrapper handles it.

    ━━━ OUTPUT FORMAT — IMPORTANT, FOLLOW EXACTLY ━━━

    The JSON recipe contains scene metadata only. Each scene's code goes in
    a SEPARATE marked block below the JSON. This avoids JSON escaping
    headaches with multi-line code.

    ===NARRATION===
    [200–240 words of voice-over, natural and flowing, references what's on screen]

    ===RECIPE===
    {
      "scenes": [
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S1"},
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S2"},
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S3"},
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S4"},
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S5"},
        {"template": "custom", "heading": "...", "subtext": "...", "code_id": "S6"}
      ]
    }

    ===CODE:S1===
    [raw Manim code for scene 1 — INTRO scene, topic-specific]

    ===CODE:S2===
    [scene 2 — core mechanism]

    ===CODE:S3===
    [scene 3 — formula / structure]

    ===CODE:S4===
    [scene 4 — concrete example]

    ===CODE:S5===
    [scene 5 — implication / why it matters]

    ===CODE:S6===
    [scene 6 — CLOSING scene, topic-specific final image]

    ━━━ DESIGN PRINCIPLES — READ CAREFULLY ━━━
    1. SHOW THE MECHANISM, don't decorate.
       BAD: "DNA helix rotating in space"
       GOOD: "DNA strands separate at the fork. Polymerase enzyme moves along
              each template strand. New bases pair in. Two daughter helices form."

    2. 2D > 3D for most concepts.
       Math equations, function graphs, force diagrams, flowcharts, cell diagrams,
       chemical structures — they're CLEARER in 2D. Only use 3D for inherently
       spatial things: atoms with electron orbitals, planets, 3D vectors, helices.
       The default camera is FLAT 2D (phi=0, theta=-PI/2). To use 3D, FIRST call:
         self.move_camera(phi=70*DEGREES, theta=-45*DEGREES, run_time=0.4)

    3. ANNOTATE EVERY ELEMENT.
       Every diagram element gets a label or arrow pointing to it.
       Use Text(...).next_to(thing, UP/DOWN/LEFT/RIGHT, buff=0.15) for labels.
       Use Arrow(start, end, color=...) to point at things.

    4. BUILD UP STEP BY STEP.
       Don't show the finished diagram all at once. Add elements one by one with
       self.play() so the viewer can follow along.
       Use Write() for text, Create() for paths, GrowFromCenter() for shapes,
       GrowArrow() for arrows.

    5. KEEP IT FOCUSED.
       Max 5–6 mobjects on screen at once. If you need more, FadeOut some before
       adding new ones. Each scene is ~12 seconds — focus on ONE idea per scene.

    6. NEVER REPEAT THE SAME VISUAL.
       Every scene in the SAME video must look different. If scene 2 shows a
       triangle, scene 3 should NOT show a triangle. Pick different shapes,
       different layouts, different focal elements per scene.

    7. ⚠️ HARD RULE: EACH SCENE'S BODY MUST RUN AT LEAST 12 SECONDS.
       Add up the run_time of every self.play() and self.wait() in your
       code. The total MUST be ≥12. If your scene is too short, ADD more
       animations. Don't pad with self.wait — pad with motion.

       BAD (5 seconds, mostly static):
         self.play(GrowFromCenter(circle), run_time=1)
         self.play(Write(label), run_time=1)
         self.wait(3)

       GOOD (13 seconds, lots of motion):
         self.play(Create(axes), run_time=1.0)
         self.play(GrowFromCenter(circle), run_time=1.0)
         self.play(circle.animate.shift(RIGHT*2), run_time=1.5)
         self.play(circle.animate.scale(0.8), run_time=1.0)
         self.play(Transform(circle, square), run_time=1.5)
         self.play(square.animate.set_color(GOLD), Write(label), run_time=1.5)
         self.play(Indicate(square), run_time=1.0)
         self.play(square.animate.shift(LEFT*3), run_time=2.0)
         self.wait(1.5)

    8. SHOW TRANSFORMATION, NOT STATE.
       Bad: "eq = Text('F=ma'); self.play(Write(eq))" — that's just text.
       Good: a block being pushed by an arrow, the arrow growing larger and
       the block accelerating faster — that SHOWS what F=ma means.
       Animate the MECHANISM. Make objects MOVE, MORPH, PAIR UP, COLLIDE,
       SEPARATE, GROW, SHRINK. That's how you teach with visuals.

    ━━━ MANIM TOOLKIT (everything you can use) ━━━

    SHAPES (2D):
      Circle(radius=1, color=BLUE_D, fill_opacity=0.3, stroke_width=2)
      Square(side_length=1, color=GREEN_C, fill_opacity=0.4)
      Rectangle(width=2, height=1, color=YELLOW_C, fill_opacity=0.5)
      Polygon(p1, p2, p3, color=RED_D, fill_opacity=0.3)  # any polygon
      RegularPolygon(n=6, color=ORANGE)  # hexagon, pentagon, etc.
      Triangle(color=PINK)  # equilateral
      Ellipse(width=2, height=1, color=PURPLE_B)
      Line(start, end, color=GREY_B, stroke_width=2)
      DashedLine(start, end, color=WHITE)
      Arrow(start, end, color=YELLOW_C, buff=0.1, stroke_width=3)
      DoubleArrow(start, end, color=BLUE_D)
      Dot(point, color=GOLD, radius=0.1)
      Vector([2, 1, 0], color=RED_D)  # arrow from origin

    SHAPES (3D — only use after move_camera to 3D):
      Sphere(radius=1, resolution=(8,8)).set_color(BLUE_D).set_opacity(0.7)
      Cube(side_length=1, fill_opacity=0.6).set_color(GREEN_C)
      Torus(major_radius=1, minor_radius=0.2).set_color(GOLD)
      Cylinder(radius=0.5, height=2)
      Dot3D(point, color=WHITE, radius=0.1)

    AXES + GRAPHS (2D):
      axes = Axes(x_range=[-4, 4, 1], y_range=[-2, 2, 1], x_length=8, y_length=4,
                  axis_config={"color": GREY_B, "stroke_width": 2})
      curve = axes.plot(lambda x: np.sin(x), color=BLUE_D, stroke_width=3, x_range=[-4, 4])
      # Use np.sin, np.cos, np.exp, np.log, x**2 etc. NEVER y=mx+b form.
      area = axes.get_area(curve, x_range=[0, PI], color=BLUE_D, opacity=0.4)
      number_line = NumberLine(x_range=[0, 10, 1], length=8)

    PARAMETRIC CURVES (2D or 3D):
      curve = ParametricFunction(
          lambda t: np.array([np.cos(t), np.sin(t), 0]),
          t_range=[0, 2*PI], color=TEAL_C, stroke_width=3)

    TEXT (use Text only — NEVER MathTex, it requires LaTeX which is slow):
      Text("Hello", font_size=28, color=WHITE, weight=BOLD)  # weight=BOLD or NORMAL
      # For math expressions, use Unicode in regular Text:
      Text("x² + y² = r²", font_size=32, color=GOLD)
      Text("F = m × a", font_size=36, weight=BOLD)
      Text("∫ f(x) dx", font_size=30)
      Text("Δx → 0", font_size=28)
      # Available unicode: ² ³ ¹ ⁰ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁻ ⁺ × ÷ ± ∞ √ ∑ ∫ Δ θ π α β γ μ σ
      # Position with: .to_edge(UP, buff=0.5), .to_corner(UR), .next_to(thing, RIGHT)
      # IMPORTANT for text on screen: self.add_fixed_in_frame_mobjects(label_obj)
      # BEFORE you play any animation involving it. This locks it to screen space.

    GROUPING:
      group = VGroup(obj1, obj2, obj3)
      group.arrange(RIGHT, buff=0.5)  # arrange children in a row
      group.arrange_in_grid(rows=2, cols=3, buff=0.3)

    ANIMATIONS:
      self.play(Write(text), run_time=1.0)            # text appears
      self.play(Create(shape), run_time=1.5)          # outline draws
      self.play(GrowFromCenter(obj), run_time=1.0)    # shape grows from center
      self.play(GrowArrow(arrow), run_time=0.8)       # arrow extends
      self.play(FadeIn(obj), FadeOut(obj))
      self.play(Transform(obj1, obj2), run_time=1.5)  # morph one into another
      self.play(obj.animate.shift(RIGHT*2), run_time=1.0)
      self.play(obj.animate.set_color(RED_D))
      self.play(Rotate(obj, PI/2, axis=OUT), run_time=1.0)
      self.play(Indicate(obj, color=YELLOW_C))
      self.play(LaggedStart(Create(a), Create(b), Create(c), lag_ratio=0.3))
      self.wait(0.5)

    POSITIONING SHORTCUTS:
      ORIGIN = [0,0,0],  UP = [0,1,0],  DOWN = [0,-1,0]
      LEFT = [-1,0,0],  RIGHT = [1,0,0]
      UL = UP+LEFT,  UR = UP+RIGHT,  DL = DOWN+LEFT,  DR = DOWN+RIGHT
      Use multiplication: UP*2 = [0,2,0]

    COLORS (use these names exactly):
      BLUE_D, BLUE_E, TEAL_C, TEAL_D, GREEN_C, GREEN_D,
      YELLOW_C, GOLD, ORANGE, RED_D, MAROON_C, PINK,
      PURPLE_B, WHITE, GREY_B, BLACK

    ━━━ STRICT RULES FOR CUSTOM CODE ━━━
    • NO Surface() — too slow on Railway CPU
    • NO imports — `np` and Manim are already imported
    • NO file I/O, NO exec/eval, NO subprocess
    • Every Text label MUST be added via self.add_fixed_in_frame_mobjects(label)
      BEFORE the first play that uses it (otherwise the camera transforms it weirdly)
    • DON'T add FadeOut at the end — the wrapper auto-fades everything.
      Just leave the visual on screen at the end of your code; the wrapper
      handles the transition out. This keeps the visual visible during the
      scene's tail (no empty gaps with just text).
    • Each scene's code should run ~10–14 seconds of self.play() time
    • If using 3D shapes, FIRST call self.move_camera(phi=70*DEGREES, theta=-45*DEGREES)
    • Labels in Manim are positional — use .to_edge(), .next_to(), .move_to() to place them
    • Use SIMPLE Python expressions for axes.plot — `np.sin(x)`, `x**2`, `np.exp(-x*x)`.
      NEVER write `y = mx + b` (assignment) or `2x + 3` (missing *) or bare `sin(x)`

    ━━━ STRUCTURE OF A GREAT SCENE ━━━
    1. Set up the diagram (axes / shapes appear)
    2. Build it piece by piece with labels
    3. Animate the key transformation (curve drawing, vector morphing, etc.)
    4. Add the takeaway annotation (formula or one-line conclusion)
    5. self.wait(1.0) to let it land — visual stays on screen
    6. (NO FadeOut — wrapper handles it automatically)

    ━━━ SCENE-BY-SCENE GUIDE ━━━
    Scene 1 (INTRO): Hook the viewer. Show the topic at its most striking —
       the shape, the equation, the silhouette. NOT a generic sphere.
       Examples: a triangle for Pythagoras, a parabola for derivatives,
       a helix for DNA, a pendulum for SHM.
    Scenes 2–5: Four DIFFERENT angles on the concept (mechanism, formula,
       example, implication). Each must show something different.
    Scene 6 (CLOSING): Final image — usually the formula or key visual,
       large and centered, fading in dramatically. NOT generic shapes.

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    FULL OUTPUT EXAMPLE — STUDY THE EXACT FORMAT
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    For topic "Pythagorean Theorem":

    ===NARRATION===
    Here's something the ancient Greeks figured out three thousand years ago.
    Take any right triangle. Build a square on each side. The two smaller
    squares — they always add up to the biggest square. Always. Watch:
    a squared, plus b squared, equals c squared. Three to the four to the
    five. Five to the twelve to the thirteen. The pattern never breaks.
    [continues to 200-240 words total...]

    ===RECIPE===
    {
      "scenes": [
        {"template": "custom", "heading": "The Pythagorean Theorem",
         "subtext": "The hidden geometry of right triangles", "code_id": "S1"},
        {"template": "custom", "heading": "A Right Triangle",
         "subtext": "Two short sides a and b, one long side c — the hypotenuse",
         "code_id": "S2"},
        {"template": "custom", "heading": "Squares On Each Side",
         "subtext": "Build a square outward from each of the three sides",
         "code_id": "S3"},
        {"template": "custom", "heading": "The Equation",
         "subtext": "Areas of the small squares equal area of the largest",
         "code_id": "S4"},
        {"template": "custom", "heading": "A Worked Example",
         "subtext": "If a=3 and b=4, then c must be exactly 5",
         "code_id": "S5"},
        {"template": "custom", "heading": "Geometry Made Real",
         "subtext": "From temples to GPS, right angles power the world",
         "code_id": "S6"}
      ]
    }

    ===CODE:S1===
    # INTRO — show 3 different right triangles to hint "this rule works for ALL of them"
    # Each triangle morphs into the next, demonstrating the universal pattern.
    A = LEFT*1.5 + DOWN*1.0
    B = RIGHT*1.5 + DOWN*1.0
    C = LEFT*1.5 + UP*1.0
    tri1 = Polygon(A, B, C, color=GOLD, stroke_width=5, fill_color=GOLD, fill_opacity=0.25)
    A2, B2, C2 = LEFT*2.0 + DOWN*0.8, RIGHT*1.0 + DOWN*0.8, LEFT*2.0 + UP*1.6
    tri2 = Polygon(A2, B2, C2, color=GOLD, stroke_width=5, fill_color=GOLD, fill_opacity=0.25)
    A3, B3, C3 = LEFT*1.0 + DOWN*1.2, RIGHT*2.5 + DOWN*1.2, LEFT*1.0 + UP*0.8
    tri3 = Polygon(A3, B3, C3, color=GOLD, stroke_width=5, fill_color=GOLD, fill_opacity=0.25)
    eq = Text('a² + b² = c²', font_size=42, weight=BOLD, color=GOLD).to_edge(DOWN, buff=1.2)
    self.add_fixed_in_frame_mobjects(eq)
    eq.set_opacity(0)
    self.play(Create(tri1), run_time=1.2)
    self.play(eq.animate.set_opacity(1), run_time=0.8)
    self.wait(0.5)
    self.play(Transform(tri1, tri2), run_time=1.5, rate_func=smooth)
    self.wait(0.5)
    self.play(Transform(tri1, tri3), run_time=1.5, rate_func=smooth)
    self.wait(0.5)
    self.play(Indicate(tri1, color=YELLOW_C, scale_factor=1.15), run_time=1.2)
    self.play(Indicate(eq, color=YELLOW_C), run_time=1.2)
    self.wait(1.5)

    ===CODE:S2===
    # MECHANISM — anatomy of a right triangle.
    # Build the triangle one side at a time, mark the right angle, label each side.
    A = LEFT*1.8 + DOWN*1.2
    B = RIGHT*1.8 + DOWN*1.2
    C = LEFT*1.8 + UP*1.2
    side_a = Line(A, B, color=GREEN_C, stroke_width=6)
    side_b = Line(A, C, color=ORANGE, stroke_width=6)
    side_c = Line(B, C, color=RED_D, stroke_width=6)
    right_marker = Square(side_length=0.3, color=YELLOW_C, stroke_width=3).move_to(A + RIGHT*0.15 + UP*0.15)
    la = Text('a', font_size=32, weight=BOLD, color=GREEN_C).next_to(side_a, DOWN, buff=0.2)
    lb = Text('b', font_size=32, weight=BOLD, color=ORANGE).next_to(side_b, LEFT, buff=0.2)
    lc = Text('c', font_size=32, weight=BOLD, color=RED_D).next_to(side_c.get_center(), UR, buff=0.15)
    hyp_lab = Text('(hypotenuse)', font_size=18, color=RED_D).next_to(lc, RIGHT, buff=0.15)
    self.add_fixed_in_frame_mobjects(la, lb, lc, hyp_lab)
    hyp_lab.set_opacity(0)
    self.play(Create(side_a), Write(la), run_time=1.2)
    self.play(Create(side_b), Write(lb), run_time=1.2)
    self.play(Create(right_marker), run_time=0.8)
    self.play(Indicate(right_marker, color=YELLOW_C, scale_factor=1.5), run_time=1.0)
    self.play(Create(side_c), Write(lc), run_time=1.2)
    self.play(hyp_lab.animate.set_opacity(1), run_time=0.6)
    self.play(Indicate(side_c, color=YELLOW_C), run_time=1.2)
    self.wait(1.5)

    ===CODE:S3===
    # FORMULA via VISUAL PROOF — squares grow from each side, with their areas.
    A = LEFT*0.5 + DOWN*0.5
    B = RIGHT*1.5 + DOWN*0.5
    C = LEFT*0.5 + UP*1.0
    tri = Polygon(A, B, C, color=WHITE, stroke_width=3, fill_color=BLUE_D, fill_opacity=0.2)
    # Square on side a (length 2, area 4)
    sq_a = Square(side_length=2.0, color=GREEN_C, fill_opacity=0.55).move_to(np.array([0.5, -1.5, 0]))
    la = Text('a²', font_size=36, weight=BOLD, color=WHITE).move_to(sq_a.get_center())
    # Square on side b (length 1.5, area 2.25)
    sq_b = Square(side_length=1.5, color=ORANGE, fill_opacity=0.55).move_to(np.array([-1.25, 0.25, 0]))
    lb = Text('b²', font_size=32, weight=BOLD, color=WHITE).move_to(sq_b.get_center())
    # Square on hypotenuse (length 2.5, area 6.25)
    sq_c = Square(side_length=2.5, color=RED_D, fill_opacity=0.55)
    sq_c.rotate(np.arctan2(1.5, 2.0)).move_to(np.array([1.7, 0.85, 0]))
    lc = Text('c²', font_size=36, weight=BOLD, color=WHITE).move_to(sq_c.get_center())
    self.add_fixed_in_frame_mobjects(la, lb, lc)
    la.set_opacity(0); lb.set_opacity(0); lc.set_opacity(0)
    self.play(Create(tri), run_time=1.0)
    self.play(GrowFromCenter(sq_a), la.animate.set_opacity(1), run_time=1.5)
    self.play(GrowFromCenter(sq_b), lb.animate.set_opacity(1), run_time=1.5)
    self.play(Indicate(sq_a), Indicate(sq_b), run_time=1.2)
    self.play(GrowFromCenter(sq_c), lc.animate.set_opacity(1), run_time=1.5)
    self.play(Indicate(sq_c, color=YELLOW_C, scale_factor=1.1), run_time=1.5)
    self.wait(1.5)

    ===CODE:S4===
    # FORMULA assembly — build "a² + b² = c²" piece by piece with colors matching squares.
    a_sq = Text('a²', font_size=72, weight=BOLD, color=GREEN_C).shift(LEFT*3)
    plus = Text('+', font_size=72, weight=BOLD, color=WHITE).shift(LEFT*1.5)
    b_sq = Text('b²', font_size=72, weight=BOLD, color=ORANGE).shift(LEFT*0.0)
    eq = Text('=', font_size=72, weight=BOLD, color=WHITE).shift(RIGHT*1.5)
    c_sq = Text('c²', font_size=72, weight=BOLD, color=RED_D).shift(RIGHT*3)
    self.add_fixed_in_frame_mobjects(a_sq, plus, b_sq, eq, c_sq)
    a_sq.set_opacity(0); plus.set_opacity(0); b_sq.set_opacity(0)
    eq.set_opacity(0); c_sq.set_opacity(0)
    self.play(a_sq.animate.set_opacity(1), run_time=0.8)
    self.play(plus.animate.set_opacity(1), run_time=0.5)
    self.play(b_sq.animate.set_opacity(1), run_time=0.8)
    self.play(eq.animate.set_opacity(1), run_time=0.5)
    self.play(c_sq.animate.set_opacity(1), run_time=0.8)
    self.play(Indicate(a_sq, color=YELLOW_C), Indicate(b_sq, color=YELLOW_C), run_time=1.2)
    self.play(Indicate(c_sq, color=YELLOW_C, scale_factor=1.2), run_time=1.5)
    full = VGroup(a_sq, plus, b_sq, eq, c_sq)
    self.play(full.animate.scale(1.1), run_time=0.8, rate_func=there_and_back)
    self.wait(1.5)

    ===CODE:S5===
    # WORKED EXAMPLE — 3-4-5 triangle with computation appearing live.
    # Triangle on left, math on right. Lines tick into existence one by one.
    A = LEFT*4 + DOWN*1.0
    B = LEFT*1 + DOWN*1.0
    C = LEFT*4 + UP*1.0
    tri = Polygon(A, B, C, color=BLUE_D, stroke_width=3, fill_color=BLUE_D, fill_opacity=0.2)
    side_a = Line(A, B, color=GREEN_C, stroke_width=5)
    side_b = Line(A, C, color=ORANGE, stroke_width=5)
    side_c = Line(B, C, color=RED_D, stroke_width=5)
    n3 = Text('3', font_size=28, color=GREEN_C).next_to(side_a, DOWN, buff=0.15)
    n4 = Text('4', font_size=28, color=ORANGE).next_to(side_b, LEFT, buff=0.15)
    nc = Text('?', font_size=32, color=RED_D).next_to(side_c.get_center(), UR, buff=0.15)
    l1 = Text('3² + 4²', font_size=38, color=WHITE).move_to(RIGHT*2 + UP*1.2)
    l2 = Text('= 9 + 16', font_size=38, color=TEAL_C).next_to(l1, DOWN, buff=0.3)
    l3 = Text('= 25', font_size=38, color=TEAL_C).next_to(l2, DOWN, buff=0.3)
    l4 = Text('c = 5', font_size=44, weight=BOLD, color=GOLD).next_to(l3, DOWN, buff=0.4)
    self.add_fixed_in_frame_mobjects(n3, n4, nc, l1, l2, l3, l4)
    for o in [l1, l2, l3, l4]: o.set_opacity(0)
    self.play(Create(tri), run_time=0.8)
    self.play(Create(side_a), Write(n3), run_time=0.8)
    self.play(Create(side_b), Write(n4), run_time=0.8)
    self.play(Create(side_c), Write(nc), run_time=0.8)
    self.play(l1.animate.set_opacity(1), run_time=0.7)
    self.play(l2.animate.set_opacity(1), run_time=0.7)
    self.play(l3.animate.set_opacity(1), run_time=0.7)
    self.play(l4.animate.set_opacity(1), run_time=0.8)
    new_c = Text('5', font_size=32, weight=BOLD, color=GOLD).next_to(side_c.get_center(), UR, buff=0.15)
    self.add_fixed_in_frame_mobjects(new_c)
    self.play(Transform(nc, new_c), Indicate(side_c, color=GOLD), run_time=1.5)
    self.wait(1.5)

    ===CODE:S6===
    # CLOSING — multiple use-cases tile in: GPS, architecture, screens, navigation.
    use1 = Text('GPS satellites', font_size=26, color=BLUE_D).move_to(UP*1.2 + LEFT*2.5)
    use2 = Text('Bridges & buildings', font_size=26, color=ORANGE).move_to(UP*1.2 + RIGHT*2.5)
    use3 = Text('Computer graphics', font_size=26, color=GREEN_C).move_to(DOWN*0.4 + LEFT*2.5)
    use4 = Text('Music & frequencies', font_size=26, color=PURPLE_B).move_to(DOWN*0.4 + RIGHT*2.5)
    eq = Text('a² + b² = c²', font_size=56, weight=BOLD, color=GOLD).move_to(DOWN*1.8)
    self.add_fixed_in_frame_mobjects(use1, use2, use3, use4, eq)
    for o in [use1, use2, use3, use4, eq]: o.set_opacity(0)
    self.play(use1.animate.set_opacity(1), run_time=0.7)
    self.play(use2.animate.set_opacity(1), run_time=0.7)
    self.play(use3.animate.set_opacity(1), run_time=0.7)
    self.play(use4.animate.set_opacity(1), run_time=0.7)
    self.wait(0.5)
    self.play(eq.animate.set_opacity(1).scale(1.0), run_time=1.2)
    self.play(Indicate(eq, color=YELLOW_C, scale_factor=1.15), run_time=1.5)
    self.play(Indicate(eq, color=YELLOW_C), run_time=1.2)
    self.wait(1.5)

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    EXTRA EXAMPLES — different subjects (each block goes inside ===CODE:Sx===):

    ━━━ Newton's Second Law (physics, 2D force diagram) ━━━
    block = Square(side_length=1.2, color=BLUE_D, fill_opacity=0.7).set_stroke(WHITE, 2)
    ground = Line(LEFT*4, RIGHT*4, color=GREY_B, stroke_width=2).shift(DOWN*0.6)
    force = Arrow(block.get_right(), block.get_right() + RIGHT*2, color=YELLOW_C, buff=0)
    f_lab = Text('F', font_size=32, weight=BOLD, color=YELLOW_C).next_to(force, UP, buff=0.1)
    m_lab = Text('m', font_size=28, weight=BOLD, color=WHITE).move_to(block.get_center())
    self.add_fixed_in_frame_mobjects(f_lab, m_lab)
    self.play(Create(ground), run_time=0.5)
    self.play(GrowFromCenter(block), Write(m_lab), run_time=0.8)
    self.play(GrowArrow(force), Write(f_lab), run_time=0.8)
    self.play(block.animate.shift(RIGHT*2), force.animate.shift(RIGHT*2),
              f_lab.animate.shift(RIGHT*2), m_lab.animate.shift(RIGHT*2),
              run_time=1.5, rate_func=smooth)
    self.wait(1.5)
    self.play(FadeOut(block, ground, force, f_lab, m_lab), run_time=0.5)

    ━━━ DNA Replication Fork (biology, 2D mechanism) ━━━
    helix_top = ParametricFunction(lambda t: np.array([t*0.3, 1.5 + 0.25*np.sin(2*t), 0]),
        t_range=[-5, 0], color=BLUE_D, stroke_width=4)
    helix_bot = ParametricFunction(lambda t: np.array([t*0.3, -1.5 - 0.25*np.sin(2*t), 0]),
        t_range=[-5, 0], color=TEAL_C, stroke_width=4)
    helix_orig = ParametricFunction(lambda t: np.array([t*0.3, 0.4*np.sin(2*t), 0]),
        t_range=[-8, -5], color=PURPLE_B, stroke_width=4)
    helicase = Circle(radius=0.35, color=ORANGE, fill_opacity=0.8).move_to(LEFT*1.5)
    h_lab = Text('Helicase', font_size=20, color=ORANGE).next_to(helicase, UP, buff=0.2)
    self.add_fixed_in_frame_mobjects(h_lab)
    self.play(Create(helix_orig), run_time=1.0)
    self.play(Create(helix_top), Create(helix_bot), run_time=1.5)
    self.play(GrowFromCenter(helicase), Write(h_lab), run_time=0.6)
    self.wait(1.5)
    self.play(FadeOut(helix_orig, helix_top, helix_bot, helicase, h_lab), run_time=0.5)

    ━━━ Water polarity (chemistry, 2D molecule + charges) ━━━
    ang = 104.5 * DEGREES / 2
    O_pos = np.array([0, 0.3, 0])
    H1_pos = O_pos + np.array([np.sin(ang)*1.5, -np.cos(ang)*1.5, 0])
    H2_pos = O_pos + np.array([-np.sin(ang)*1.5, -np.cos(ang)*1.5, 0])
    O = Circle(radius=0.55, color=RED_D, fill_opacity=0.85).move_to(O_pos)
    H1 = Circle(radius=0.32, color=WHITE, fill_opacity=0.85).move_to(H1_pos)
    H2 = Circle(radius=0.32, color=WHITE, fill_opacity=0.85).move_to(H2_pos)
    b1 = Line(O_pos, H1_pos, color=BLUE_D, stroke_width=4)
    b2 = Line(O_pos, H2_pos, color=BLUE_D, stroke_width=4)
    ol = Text('O', font_size=28, weight=BOLD, color=WHITE).move_to(O.get_center())
    neg = Text('δ-', font_size=24, weight=BOLD, color=BLUE_D).next_to(O, UP, buff=0.15)
    self.add_fixed_in_frame_mobjects(ol, neg)
    neg.set_opacity(0)
    self.play(GrowFromCenter(O), Write(ol), run_time=0.6)
    self.play(Create(b1), Create(b2), GrowFromCenter(H1), GrowFromCenter(H2), run_time=1.0)
    self.play(neg.animate.set_opacity(1), run_time=0.8)
    self.wait(2)
    self.play(FadeOut(O, H1, H2, b1, b2, ol, neg), run_time=0.5)

    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    ━━━ HEADING + SUBTEXT ━━━
    Heading (≤45 chars): the BIG concept name. Acts as the slide title.
    Subtext (≤70 chars): one-line plain-language explanation.
    Both stay on screen during the whole scene.

    Heading examples:
      "The Replication Fork"  /  "Newton's Second Law"  /  "Binary Search"
      "Water is Polar"  /  "The Pythagorean Theorem"

    ━━━ COLOR PALETTE ━━━
    BLUE_D, BLUE_E, TEAL_C, TEAL_D, GREEN_C, GREEN_D,
    YELLOW_C, GOLD, ORANGE, RED_D, MAROON_C, PINK,
    PURPLE_B, WHITE, GREY_B

    ━━━ NARRATION ━━━
    • 200–240 words (~90 seconds at TTS speed)
    • Brilliant teacher tone, genuine wonder
    • Reference what's on screen ("watch the fork separate the strands…")
    • Build intuition first, technical terms second
    • Sentences flow with the 6 scenes in order

    ━━━ FINAL CHECKLIST BEFORE OUTPUT ━━━
    □ Exactly 6 scenes, all "template": "custom" with code_id S1..S6
    □ Each scene's code ends with self.wait(1.0) — NO FadeOut at the end
    □ Every Text label is added via add_fixed_in_frame_mobjects BEFORE play
    □ Every scene's visual is DIFFERENT from the other scenes in the video
    □ Scene 1 is topic-specific (NOT a generic sphere)
    □ Scene 6 is topic-specific (NOT generic shapes)
    □ No Surface(), no imports, no exec/eval
    □ Every scene has heading + subtext
    □ Output is VALID JSON inside ===RECIPE===
    □ Each ===CODE:Sx=== block contains raw Manim code, no JSON escaping
    """
).strip()


# ──────────────────────────────────────────────────────────────────────────
# Parsing
# ──────────────────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


_CODE_BLOCK_RE = re.compile(
    r"===\s*CODE\s*:\s*(\w+)\s*===\s*\n(.*?)(?=\n===|\Z)",
    re.DOTALL,
)


def _parse_response(raw: str) -> tuple[str, dict]:
    """Split LLM output into narration + recipe dict.

    New format (V2):
      ===NARRATION=== ... ===RECIPE=== {json with code_id refs} ===CODE:Sx===
      <raw multi-line code> ===CODE:Sy=== ...

    The narrator can also still send the older single-block format with
    embedded `code` fields — we accept both.
    """
    if "===RECIPE===" not in raw:
        raise GenerationError("LLM response missing ===RECIPE=== marker")

    # Step 1: split off the narration (everything before ===RECIPE===)
    pre, _, after_recipe = raw.partition("===RECIPE===")
    narration = pre.replace("===NARRATION===", "").strip()

    # Step 2: pull all ===CODE:Sx=== blocks. They're greedy until the next
    # ===…=== marker or end of string.
    code_blocks: dict[str, str] = {}
    for m in _CODE_BLOCK_RE.finditer(after_recipe):
        code_id = m.group(1).strip()
        code_body = m.group(2).strip()
        # Strip leading code fence if the LLM wrapped it (```python ... ```)
        if code_body.startswith("```"):
            code_body = re.sub(r"^```[a-zA-Z]*\n?", "", code_body)
            code_body = re.sub(r"\n?```\s*$", "", code_body).strip()
        code_blocks[code_id] = code_body

    # Step 3: isolate the recipe JSON (everything between ===RECIPE=== and the
    # first ===CODE:…=== if any, else everything after).
    first_code_pos = after_recipe.find("===CODE")
    if first_code_pos >= 0:
        recipe_str = after_recipe[:first_code_pos].strip()
    else:
        recipe_str = after_recipe.strip()

    recipe_str = _strip_fences(recipe_str)
    if not recipe_str.startswith("{"):
        m = re.search(r"\{[\s\S]*\}", recipe_str)
        if not m:
            raise GenerationError(f"Could not find JSON object in recipe: {recipe_str[:200]}")
        recipe_str = m.group(0)

    try:
        recipe = json.loads(recipe_str)
    except json.JSONDecodeError as e:
        raise GenerationError(f"Recipe JSON invalid: {e}\n\n{recipe_str[:400]}") from e

    # Step 4: resolve code_id references — inject the real code into each scene
    if isinstance(recipe.get("scenes"), list):
        for i, scene in enumerate(recipe["scenes"]):
            if not isinstance(scene, dict):
                continue
            ref = scene.get("code_id")
            if ref:
                if ref not in code_blocks:
                    raise GenerationError(
                        f"Scene #{i} refers to code_id={ref!r} but no ===CODE:{ref}=== "
                        f"block was provided. Available: {list(code_blocks.keys())}"
                    )
                scene["code"] = code_blocks[ref]
                scene.pop("code_id", None)

    return narration, recipe


# ──────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────

async def generate_scene_code(
    topic: str,
    prompt: str = "",
    style: str = "",         # ignored — kept for API compat
    use_3d: bool = True,     # ignored — always premium 3D
) -> tuple[str, str]:
    """Returns (narration_text, manim_code) — composed from templates."""
    validate_topic(topic)

    if os.getenv("ALEX_DEMO_FREE_MODE", "false").strip().lower() in ("true", "1", "yes"):
        raise GenerationError("Live AI video generation is disabled in free demo mode")
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise GenerationError("OPENROUTER_API_KEY is not set")

    if prompt.strip():
        guidance = f"Focus hint from user: {prompt}"
    else:
        guidance = "No specific hint — pick the most insightful angle for this topic."

    user_prompt = textwrap.dedent(
        f"""
        TOPIC: {topic}
        {guidance}

        DESIGN a 6-scene educational video that genuinely TEACHES this topic.

        ALL 6 scenes are custom Manim code that YOU write — no templates.
        Each scene shows a different aspect:
          Scene 1 (INTRO):   Hook — striking topic-specific opening visual
          Scene 2:           The core mechanism / what's happening
          Scene 3:           The formula or structure, labelled
          Scene 4:           A concrete example or worked case
          Scene 5:           The implication or why it matters
          Scene 6 (CLOSING): Final memorable image — the formula or key shape

        Each scene's code must:
          - Be valid Manim code (~12–25 lines is plenty)
          - Default to 2D unless the concept genuinely needs 3D
          - Build the diagram step by step with labels and animations
          - End with self.wait(1.0) — DO NOT call FadeOut; the wrapper does it
          - Be VISUALLY DIFFERENT from every other scene in the same video

        Pick the right COLORS for the topic (warm palette for biology, cool
        for math, gold/yellow for physics, etc).

        Write 200–240 words of voice-over narration that flows naturally with
        the 6 scenes in order — narration sentences must MATCH what's on screen
        at each scene.

        Output narration AND recipe now in the format from the system prompt.
        """
    ).strip()

    payload = {
        "model": MODEL,
        "temperature": 0.5,
        "max_tokens": 6000,        # 4 custom scenes × ~40 lines + narration + JSON overhead
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://alexstudies.com",
        "X-Title": "Alex Video Service",
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(OPENROUTER_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise GenerationError(
                f"OpenRouter {resp.status_code} for model {MODEL}: {resp.text[:600]}"
            )
        data = resp.json()

    try:
        raw = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise GenerationError(f"Unexpected LLM response shape: {data}") from e

    narration, recipe = _parse_response(raw)

    # Compose recipe → real Manim code
    try:
        code = compose_scene(recipe)
    except RecipeError as e:
        # Fallback: if the LLM hallucinated a template, try a safe minimal recipe
        raise GenerationError(f"Recipe invalid: {e}") from e

    return narration, code
