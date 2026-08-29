#!/usr/bin/env python3
"""Generate the animated terminal demo embedded in the user README.

Transcript provenance:
- The init/install/start/status/stop results were captured from the bundled
  packages/cli/dist/cli.mjs on 2026-08-29 with Node.js 24.20.0, Java 25.0.3,
  and Paper 26.2 build 120. Environment-specific absolute paths are normalized
  to /srv/minecraft and the captured PIDs and installation UUID are retained.
- The EULA screens mirror renderEulaFrame() in
  packages/cli/src/presentation/eula.ts, which is covered by unit tests.

This script installs nothing. It requires Pillow to be available in the Python
environment used to regenerate the checked-in GIF.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Iterable

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as error:
    raise SystemExit(
        "Pillow is required to regenerate docs/assets/craflet-demo.gif. "
        "Install it in an isolated tooling environment before running this script."
    ) from error


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "assets" / "craflet-demo.gif"
WIDTH = 960
HEIGHT = 540
MARGIN_X = 34
CONTENT_TOP = 64
FONT_SIZE = 17
LINE_HEIGHT = 21

BACKGROUND = "#0d1117"
TITLE_BAR = "#161b22"
BORDER = "#30363d"
FOREGROUND = "#c9d1d9"
MUTED = "#8b949e"
PROMPT = "#3fb950"
ACCENT = "#58a6ff"
PURPLE = "#bc8cff"
STRING = "#7ee787"
WARNING = "#d29922"
CURSOR = "#f0f6fc"

INSTALLATION_ID = "177af4a4-f3d8-4be7-903e-e4b143dbb97d"

INIT_COMMAND = (
    "craflet init survival --name survival --type paper "
    "--version 26.2 --build 120"
)
INIT_RESULT = [
    "{",
    '    "directory": "/srv/minecraft/survival",',
    '    "name": "survival",',
    '    "server": {',
    '        "type": "paper",',
    '        "version": "26.2",',
    '        "build": "120"',
    "    },",
    '    "next": "Review craflet.yaml, then run craflet install and craflet doctor."',
    "}",
]
INSTALL_RESULT = [
    "[",
    "    {",
    '        "project": "survival",',
    '        "changed": true,',
    f'        "pendingId": "{INSTALLATION_ID}",',
    '        "plugins": []',
    "    }",
    "]",
]
START_RESULT = [
    "[",
    "    {",
    '        "project": "survival",',
    '        "result": {',
    '            "status": "running",',
    '            "pid": 5360,',
    '            "javaPid": 2968,',
    f'            "activeId": "{INSTALLATION_ID}",',
    '            "clean": true',
    "        }",
    "    }",
    "]",
]
STATUS_RESULT = [
    "{",
    '    "status": "running",',
    '    "pid": 5360,',
    '    "javaPid": 2968,',
    f'    "activeId": "{INSTALLATION_ID}",',
    '    "clean": true',
    "}",
]
STOP_RESULT = [
    "{",
    '    "status": "stopped",',
    '    "clean": true,',
    '    "exitCode": 0',
    "}",
]

EULA_DOCUMENT = [
    "Review the EULA document",
    "File: /srv/minecraft/survival/runtime/eula.txt",
    "Full agreement: https://www.minecraft.net/eula",
    "",
    "# No EULA file exists yet. This preview has not been saved.",
    "# Minecraft EULA: https://www.minecraft.net/eula",
    "eula=false",
    "",
    "-" * 78,
    "Lines 1-7 of 7",
    "Up/Down/PgUp/PgDn: scroll",
    "Home/End: top/bottom",
    "Enter: continue | q/Esc: cancel",
]
EULA_CONFIRM_DECLINE = [
    "Accept the Minecraft EULA?",
    "Scope: this OS user and host.",
    "Future projects in this home reuse it.",
    "",
    "> Decline",
    "  Agree",
    "",
    "Arrows: select | Enter: confirm",
    "q/Esc/Ctrl-C: cancel",
]
EULA_CONFIRM_AGREE = [
    "Accept the Minecraft EULA?",
    "Scope: this OS user and host.",
    "Future projects in this home reuse it.",
    "",
    "  Decline",
    "> Agree",
    "",
    "Arrows: select | Enter: confirm",
    "q/Esc/Ctrl-C: cancel",
]


def font_candidates() -> Iterable[Path]:
    yield Path("C:/Windows/Fonts/CascadiaMono.ttf")
    yield Path("C:/Windows/Fonts/consola.ttf")
    yield Path("/System/Library/Fonts/Menlo.ttc")
    yield Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    yield Path("/usr/share/fonts/TTF/DejaVuSansMono.ttf")


def load_font(explicit: str | None) -> ImageFont.FreeTypeFont:
    candidates = [Path(explicit)] if explicit else list(font_candidates())
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), FONT_SIZE)
    raise SystemExit(
        "No supported monospace font was found. Pass --font with a local "
        "TrueType or OpenType monospace font."
    )


def line_color(line: str) -> str:
    stripped = line.strip()
    if line.startswith("$ "):
        return FOREGROUND
    if stripped in {"Review the EULA document", "Accept the Minecraft EULA?"}:
        return ACCENT
    if line.startswith("> "):
        return PROMPT if line == "> Agree" else WARNING
    if stripped.startswith('"') and '":' in stripped:
        return PURPLE
    if "running" in line:
        return STRING
    if "stopped" in line:
        return WARNING
    if line.startswith("-") or stripped.startswith(
        ("Lines ", "Up/", "Home/", "Enter:", "Arrows:", "q/")
    ):
        return MUTED
    if line.startswith("#"):
        return MUTED
    return FOREGROUND


def draw_line(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.FreeTypeFont,
    x: int,
    y: int,
    line: str,
) -> None:
    if line.startswith("$ "):
        draw.text((x, y), "$", font=font, fill=PROMPT)
        prompt_width = draw.textlength("$ ", font=font)
        draw.text((x + prompt_width, y), line[2:], font=font, fill=FOREGROUND)
        return
    draw.text((x, y), line, font=font, fill=line_color(line))


def render(
    font: ImageFont.FreeTypeFont,
    title: str,
    lines: list[str],
    *,
    cursor: bool = False,
) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (1, 1, WIDTH - 2, HEIGHT - 2),
        radius=12,
        fill=BACKGROUND,
        outline=BORDER,
        width=2,
    )
    draw.rounded_rectangle(
        (2, 2, WIDTH - 3, 48),
        radius=10,
        fill=TITLE_BAR,
    )
    draw.rectangle((2, 36, WIDTH - 3, 48), fill=TITLE_BAR)
    for x, color in ((20, "#ff5f56"), (42, "#ffbd2e"), (64, "#27c93f")):
        draw.ellipse((x, 18, x + 11, 29), fill=color)
    title_width = draw.textlength(title, font=font)
    draw.text(
        ((WIDTH - title_width) / 2, 14),
        title,
        font=font,
        fill=MUTED,
    )

    visible = lines[-22:]
    for index, line in enumerate(visible):
        draw_line(
            draw,
            font,
            MARGIN_X,
            CONTENT_TOP + index * LINE_HEIGHT,
            line,
        )
    if cursor and visible:
        last = visible[-1]
        cursor_x = MARGIN_X + draw.textlength(last, font=font) + 2
        cursor_y = CONTENT_TOP + (len(visible) - 1) * LINE_HEIGHT + 3
        draw.rectangle(
            (cursor_x, cursor_y, cursor_x + 9, cursor_y + FONT_SIZE),
            fill=CURSOR,
        )
    return image


def add_frame(
    frames: list[Image.Image],
    durations: list[int],
    frame: Image.Image,
    duration: int,
) -> None:
    frames.append(frame)
    durations.append(duration)


def add_typing(
    frames: list[Image.Image],
    durations: list[int],
    font: ImageFont.FreeTypeFont,
    title: str,
    command: str,
    *,
    prefix: list[str] | None = None,
    step: int = 5,
) -> None:
    prior = prefix or []
    positions = list(range(0, len(command), step)) + [len(command)]
    for index, position in enumerate(positions):
        shown = command[:position]
        add_frame(
            frames,
            durations,
            render(font, title, [*prior, f"$ {shown}"], cursor=True),
            55 if index < len(positions) - 1 else 650,
        )


def generate(font: ImageFont.FreeTypeFont) -> tuple[list[Image.Image], list[int]]:
    frames: list[Image.Image] = []
    durations: list[int] = []

    add_typing(
        frames,
        durations,
        font,
        "craflet - Paper setup",
        INIT_COMMAND,
        step=6,
    )
    add_frame(
        frames,
        durations,
        render(font, "craflet - EULA review", EULA_DOCUMENT),
        1900,
    )
    add_frame(
        frames,
        durations,
        render(font, "craflet - EULA confirmation", EULA_CONFIRM_DECLINE),
        700,
    )
    add_frame(
        frames,
        durations,
        render(font, "craflet - EULA confirmation", EULA_CONFIRM_AGREE),
        950,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Paper setup",
            [f"$ {INIT_COMMAND}", *INIT_RESULT, "$ cd survival"],
        ),
        1900,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Prepare the next start",
        "craflet install",
        prefix=["$ cd survival"],
        step=3,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Prepare the next start",
            ["$ craflet install", *INSTALL_RESULT],
        ),
        1700,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Managed start",
        "craflet start",
        step=3,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Managed start",
            ["$ craflet start", *START_RESULT],
        ),
        1900,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Status and graceful stop",
            [
                "$ craflet status",
                *STATUS_RESULT,
                "$ craflet stop",
                *STOP_RESULT,
            ],
        ),
        2300,
    )
    return frames, durations


def save_gif(
    output: Path,
    frames: list[Image.Image],
    durations: list[int],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    palette = frames[0].quantize(
        colors=64,
        method=Image.Quantize.FASTOCTREE,
        dither=Image.Dither.NONE,
    )
    indexed = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE)
        for frame in frames
    ]
    indexed[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=indexed[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
    )


def verify(output: Path, expected_frames: int) -> None:
    with Image.open(output) as image:
        if (
            image.format != "GIF"
            or not getattr(image, "is_animated", False)
            or image.n_frames != expected_frames
            or image.size != (WIDTH, HEIGHT)
        ):
            raise SystemExit(f"Generated GIF failed verification: {output}")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(
        f"Generated {output.relative_to(ROOT)} "
        f"({expected_frames} frames, {output.stat().st_size} bytes, sha256 {digest})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the Craflet README terminal demo GIF."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="GIF output path",
    )
    parser.add_argument(
        "--font",
        help="path to a monospace TrueType or OpenType font",
    )
    args = parser.parse_args()

    font = load_font(args.font)
    frames, durations = generate(font)
    output = args.output.resolve()
    save_gif(output, frames, durations)
    verify(output, len(frames))


if __name__ == "__main__":
    main()
