import argparse

from config import TARGET_CONFIGS
from monitor import main_loop


def _normalize_type(t: str) -> str:
    return t.strip().lower()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python main.py",
        description="SJTU sports venue monitor (terminal UI).",
    )

    parser.add_argument(
        "--tennis",
        action="store_true",
        help="Monitor only Tennis venues.",
    )
    parser.add_argument(
        "--badminton",
        action="store_true",
        help="Monitor only Badminton venues.",
    )
    parser.add_argument(
        "--gym",
        action="store_true",
        help="Monitor only Gym venues.",
    )

    return parser.parse_args()


def select_targets(args: argparse.Namespace):
    wanted = set()
    if args.tennis:
        wanted.add("tennis")
    if args.badminton:
        wanted.add("badminton")
    if args.gym:
        wanted.add("gym")

    # default: monitor all
    if not wanted:
        return TARGET_CONFIGS

    selected = [cfg for cfg in TARGET_CONFIGS if _normalize_type(str(cfg.get("type", ""))) in wanted]
    return selected


def main() -> None:
    args = parse_args()
    targets = select_targets(args)

    # If user specified filters but nothing matched, we still run with empty -> main_loop exits.
    main_loop(targets)


if __name__ == "__main__":
    main()
