#!/usr/bin/env python3
"""Generate the animated terminal demo embedded in the user README.

The transcript demonstrates the normal human-facing CLI workflow: create a
Paper project, resolve its server JAR, add a Modrinth plugin, start the server,
attach an interactive console, register a backup repository, prepare an update
while the old version remains active, and apply the pending version on restart.
It assumes BACKUP_PASSWORD is already set and /backup is an empty local backup
destination.

Version provenance, verified from primary APIs on 2026-08-29:
- https://fill.papermc.io/v3/projects/paper/versions/26.2/builds returned
  stable build 120 and paper-26.2-120.jar with SHA-256
  2d1a4c3e5152171c3ef327a8ae10baeae44d6c13b4620bc2578cc15ea6c6ab47.
- https://api.modrinth.com/v2/project/luckperms/version/v5.5.53-bukkit
  returned release MBSY8toc for Bukkit/Paper and game version 26.2. The
  /v2/project/luckperms/version list, filtered to Paper/Bukkit/Spigot and 26.2,
  returned release b0mk8uS6 (v5.5.71-bukkit) as the latest eligible version.
- The `list` console command is present in the official Minecraft 26.2 server
  command report. Its displayed response was captured from the pinned Paper
  26.2 build above on 2026-08-30.

Environment-specific paths, process IDs, timestamps, and terminal escape
sequences are normalized.

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
CURSOR = "#f0f6fc"

INSTALLATION_ID = "177af4a4-f3d8-4be7-903e-e4b143dbb97d"
NEXT_INSTALLATION_ID = "83cd83c0-ea08-49de-a1e1-86c7eb52d1d8"

INIT_COMMAND = (
    "craflet init survival --name survival --type paper "
    "--version 26.2 --build 120 --yes"
)
INIT_RESULT = [
    'Created Paper server "survival" at /srv/minecraft/survival.',
    "Server version: 26.2 (build 120)",
    "Next: Review craflet.yaml, then run craflet install and craflet doctor.",
]
INSTALL_COMMAND = "craflet install"
INSTALL_RESULT = [
    "Prepared 1 pending installation.",
    "survival: pending ready; no declared plugins",
    "Running JARs were not replaced.",
    "Apply the pending installation with craflet start or craflet restart.",
]
ADD_COMMAND = "craflet add modrinth:luckperms@v5.5.53-bukkit"
ADD_RESULT = [
    "Added plugins and prepared 1 pending installation.",
    "survival: pending ready; declared plugins: LuckPerms",
    "Running JARs were not replaced.",
    "Apply the pending installation with craflet start or craflet restart.",
]
START_RESULT = [
    "Started 1 server.",
    "survival: running",
    f"  Active installation: {INSTALLATION_ID}",
    "  Process: runner 5360, Java 2968",
    "  Last shutdown: clean",
]
CONSOLE_RESULT = [
    "[12:34:56 INFO]: There are 0 of a max of 20 players online:",
    "^C",
    "Detached from the server console; the server was not stopped.",
]
STATUS_RESULT = [
    "Server: running",
    f"  Active installation: {INSTALLATION_ID}",
    "  Process: runner 5360, Java 2968",
]
BACKUP_COMMAND = (
    "craflet backup setup --path /backup --password-env BACKUP_PASSWORD "
    "--init --yes"
)
BACKUP_RESULT = ['Configured backup repository "main" at /backup.']
OUTDATED_RESULT = [
    "1 update available.",
    "Project: survival",
    "  LuckPerms: v5.5.53-bukkit -> v5.5.71-bukkit",
]
UPDATE_RESULT = [
    "Resolved updates and prepared 1 pending installation.",
    "Requested updates: LuckPerms.",
    "survival: pending ready; declared plugins: LuckPerms",
    "Running JARs were not replaced.",
    "Apply the pending installation with craflet start or craflet restart.",
]
LIST_PENDING_RESULT = [
    "Project: survival",
    "Server: paper 26.2 | locked 26.2 | active 26.2",
    "Plugins:",
    "  LuckPerms: requested modrinth@v5.5.71-bukkit | active v5.5.53-bukkit | pending v5.5.71-bukkit | locked v5.5.71-bukkit",
]
RESTART_RESULT = [
    "Restarted 1 server.",
    "survival: running",
    f"  Active installation: {NEXT_INSTALLATION_ID}",
    "  Process: runner 5412, Java 3096",
    "  Last shutdown: clean",
]
LIST_FINAL_RESULT = [
    "Project: survival",
    "Server: paper 26.2 | locked 26.2 | active 26.2",
    "Plugins:",
    "  LuckPerms: requested modrinth@v5.5.71-bukkit | active v5.5.71-bukkit | pending - | locked v5.5.71-bukkit",
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
    if stripped.startswith(
        (
            "Created ",
            "Prepared ",
            "Added ",
            "Started ",
            "Restarted ",
            "Configured ",
        )
    ) or "pending ready" in line:
        return STRING
    if stripped.startswith(("Project:", "Plugins:", "Server:")):
        return ACCENT
    if stripped.startswith(
        (
            "Running JAR",
            "Apply the pending",
            "Next:",
            "Detached from",
            "^C",
        )
    ):
        return MUTED
    if "->" in line or "pending " in line:
        return PURPLE
    if "running" in line:
        return STRING
    return FOREGROUND


def draw_line(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.FreeTypeFont,
    x: int,
    y: int,
    line: str,
    color: str | None = None,
) -> None:
    if line.startswith("$ "):
        draw.text((x, y), "$", font=font, fill=PROMPT)
        prompt_width = draw.textlength("$ ", font=font)
        draw.text((x + prompt_width, y), line[2:], font=font, fill=FOREGROUND)
        return
    draw.text((x, y), line, font=font, fill=color or line_color(line))


def wrap_visual_line(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.FreeTypeFont,
    line: str,
) -> list[str]:
    """Wrap a transcript line to the visible terminal width."""
    max_width = WIDTH - (2 * MARGIN_X)
    wrapped: list[str] = []
    remaining = line
    while remaining and draw.textlength(remaining, font=font) > max_width:
        low, high = 1, len(remaining)
        while low <= high:
            middle = (low + high) // 2
            if draw.textlength(remaining[:middle], font=font) <= max_width:
                low = middle + 1
            else:
                high = middle - 1
        split_at = max(1, high)
        separator_at = remaining.rfind(" | ", 0, split_at + 1)
        if separator_at > 0:
            wrapped.append(remaining[:separator_at])
            remaining = remaining[separator_at + 1 :]
            continue
        space_at = remaining.rfind(" ", 0, split_at + 1)
        if space_at > 0:
            split_at = space_at
            wrapped.append(remaining[:split_at])
            remaining = remaining[split_at + 1 :]
        else:
            wrapped.append(remaining[:split_at])
            remaining = remaining[split_at:]
    wrapped.append(remaining)
    return wrapped


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

    visual_lines = [
        (wrapped, line_color(line))
        for line in lines
        for wrapped in wrap_visual_line(draw, font, line)
    ]
    visible = visual_lines[-22:]
    for index, (line, color) in enumerate(visible):
        draw_line(
            draw,
            font,
            MARGIN_X,
            CONTENT_TOP + index * LINE_HEIGHT,
            line,
            color,
        )
    if cursor and visible:
        last = visible[-1][0]
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
    prompt: str = "$ ",
    step: int = 5,
) -> None:
    prior = prefix or []
    positions = list(range(0, len(command), step)) + [len(command)]
    for index, position in enumerate(positions):
        shown = command[:position]
        add_frame(
            frames,
            durations,
            render(font, title, [*prior, f"{prompt}{shown}"], cursor=True),
            55 if index < len(positions) - 1 else 650,
        )


def generate(font: ImageFont.FreeTypeFont) -> tuple[list[Image.Image], list[int]]:
    frames: list[Image.Image] = []
    durations: list[int] = []

    add_typing(
        frames,
        durations,
        font,
        "craflet - Create a Paper server",
        INIT_COMMAND,
        step=7,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Create a Paper server",
            [f"$ {INIT_COMMAND}", *INIT_RESULT, "$ cd survival"],
        ),
        1600,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Resolve the server JAR",
        INSTALL_COMMAND,
        prefix=["$ cd survival"],
        step=4,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Resolve the server JAR",
            [f"$ {INSTALL_COMMAND}", *INSTALL_RESULT],
        ),
        1500,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Add LuckPerms from Modrinth",
        ADD_COMMAND,
        step=6,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Add LuckPerms from Modrinth",
            [f"$ {ADD_COMMAND}", *ADD_RESULT],
        ),
        1650,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Start the prepared installation",
        "craflet start",
        step=3,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Start the prepared installation",
            ["$ craflet start", *START_RESULT],
        ),
        1650,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Attach the interactive console",
        "craflet console",
        step=3,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Attach the interactive console",
        "list",
        prefix=["$ craflet console"],
        prompt="",
        step=1,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Detach without stopping the server",
            [
                "$ craflet console",
                "list",
                *CONSOLE_RESULT,
                "$ craflet status",
                *STATUS_RESULT,
            ],
        ),
        2600,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Register backups before updates",
        BACKUP_COMMAND,
        step=6,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Register backups before updates",
            [f"$ {BACKUP_COMMAND}", *BACKUP_RESULT],
        ),
        1500,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Check plugin updates",
        "craflet outdated LuckPerms",
        step=4,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Check plugin updates",
            ["$ craflet outdated LuckPerms", *OUTDATED_RESULT],
        ),
        1500,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Prepare the update",
        "craflet update LuckPerms",
        step=4,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Prepare the update",
            ["$ craflet update LuckPerms", *UPDATE_RESULT],
        ),
        1650,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Active stays unchanged",
            ["$ craflet list", *LIST_PENDING_RESULT],
        ),
        1650,
    )
    add_typing(
        frames,
        durations,
        font,
        "craflet - Apply pending on restart",
        "craflet restart",
        step=3,
    )
    add_frame(
        frames,
        durations,
        render(
            font,
            "craflet - Apply pending on restart",
            [
                "$ craflet restart",
                *RESTART_RESULT,
                "$ craflet list",
                *LIST_FINAL_RESULT,
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
    try:
        shown = output.relative_to(ROOT)
    except ValueError:
        shown = output
    print(
        f"Generated {shown} "
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
