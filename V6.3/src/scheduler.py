import os
import shutil
import time
import subprocess
import threading
from datetime import datetime, timedelta
from pathlib import Path
from colorama import Fore, Style

def get_latest_file(directory, pattern="*.csv"):
    p = Path(directory)
    if not p.exists():
        return None
    files = list(p.glob(pattern))
    if not files:
        return None
    return max(files, key=lambda f: f.stat().st_mtime)

def run_generator(generator_dir):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"\n  {Fore.CYAN}┌──────────────────────────────────────────────────────────┐{Style.RESET_ALL}")
    print(f"  {Fore.CYAN}│{Style.RESET_ALL}  {Style.BRIGHT}SCHEDULED UPDATE:{Style.RESET_ALL} Running Pairs Generator V6.3...    {Fore.CYAN}│{Style.RESET_ALL}")
    print(f"  {Fore.CYAN}└──────────────────────────────────────────────────────────┘{Style.RESET_ALL}")
    
    try:
        import sys
        # Run main.py in Pairs Generator V6.3
        result = subprocess.run([sys.executable, "main.py"], cwd=generator_dir, check=True, capture_output=True)
        print(f"  {Style.DIM}[{ts}] [scheduler] Pairs Generator V6.3 finished successfully.{Style.RESET_ALL}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  {Fore.RED}[{ts}] [scheduler] ERROR running Pairs Generator V6.3: {e}{Style.RESET_ALL}")
        if e.stderr:
            print(f"  {Fore.RED}Details: {e.stderr.decode()}{Style.RESET_ALL}")
        return False
    except Exception as e:
        print(f"  {Fore.RED}[{ts}] [scheduler] Unexpected error: {e}{Style.RESET_ALL}")
        return False

def run_export(v6_dir, cfg):
    """Export today's trades log to a dated CSV in data/."""
    ts = datetime.now().strftime("%H:%M:%S")
    try:
        from export_trades import dated_export
        out_path = dated_export(cfg=cfg)
        print(f"  {Style.DIM}[{ts}] [scheduler] Trade export written: {out_path}{Style.RESET_ALL}")
    except Exception as e:
        print(f"  {Fore.YELLOW}[{ts}] [scheduler] Trade export failed: {e}{Style.RESET_ALL}")


def copy_newest_output(generator_outputs, v6_inputs):
    ts = datetime.now().strftime("%H:%M:%S")
    latest_output = get_latest_file(generator_outputs)
    if not latest_output:
        print(f"  {Fore.YELLOW}[{ts}] [scheduler] No output file found in {generator_outputs}{Style.RESET_ALL}")
        return False
    
    v6_inputs.mkdir(parents=True, exist_ok=True)
    target_path = v6_inputs / latest_output.name
    
    # Don't copy if it's already there and same size/time
    if target_path.exists() and target_path.stat().st_mtime >= latest_output.stat().st_mtime:
        print(f"  {Style.DIM}[{ts}] [scheduler] Latest file already exists in input_files.{Style.RESET_ALL}")
        return False

    print(f"  {Fore.GREEN}  [scheduler] Copying {latest_output.name} to {v6_inputs.name}/...{Style.RESET_ALL}")
    shutil.copy2(latest_output, target_path)
    
    print(f"  {Fore.GREEN}  [scheduler] Update complete. Bot will hot-reload automatically.{Style.RESET_ALL}\n")
    return True

def scheduler_loop(cfg):
    """
    Background loop that checks the time and runs the generator at 3 AM.
    """
    # Resolve paths relative to the V6 EXP directory
    v6_dir = Path(__file__).parent.parent.resolve()
    root_dir = v6_dir.parent
    generator_dir = root_dir / "Pairs Generator V6.3"
    generator_outputs = generator_dir / "outputs"
    v6_inputs = v6_dir / cfg.get("input_files_dir", "input_files")

    last_run_date = None
    
    print(f"  [scheduler] Background updater active. Target time: 08:00 UTC (03:00 CDT) daily.")

    # Optional: Run immediately on startup
    if cfg.get("update_on_startup", False):
        print(f"  [scheduler] Running initial startup update...")
        if run_generator(generator_dir):
            copy_newest_output(generator_outputs, v6_inputs)
        last_run_date = datetime.now().date()

    if cfg.get("export_on_startup", False):
        run_export(v6_dir, cfg)

    while True:
        now = datetime.now()

        # Check if it's 8:00 AM UTC (3:00 AM CDT) and we haven't run today
        if now.hour == 8 and now.minute == 0 and last_run_date != now.date():
            if run_generator(generator_dir):
                copy_newest_output(generator_outputs, v6_inputs)
            run_export(v6_dir, cfg)
            last_run_date = now.date()
        
        # Sleep for 30 seconds before checking again
        time.sleep(30)

def start_daily_scheduler(cfg):
    """Starts the 3 AM scheduler in a daemon thread."""
    if not cfg.get("auto_update_pairs", True):
        return
        
    t = threading.Thread(target=scheduler_loop, args=(cfg,), daemon=True)
    t.start()
