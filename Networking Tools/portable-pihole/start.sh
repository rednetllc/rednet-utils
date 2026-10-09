#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3,10))'; then
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo 'Install Homebrew (https://brew.sh) or Python 3.10+ first.' >&2; exit 1; }
      brew install python ;;
    Linux)
      ident=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
      case "$ident" in
        ubuntu) sudo apt-get update; sudo apt-get install -y python3 ;;
        fedora) sudo dnf install -y python3 ;;
        arch) sudo pacman -Syu --needed --noconfirm python ;;
        *) echo "Unsupported automatic bootstrap distro: $ident" >&2; exit 1 ;;
      esac ;;
    *) echo 'Use start.ps1 on Windows.' >&2; exit 1 ;;
  esac
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3,10))' || { echo 'Python 3.10+ is required.' >&2; exit 1; }
exec python3 deploy.py "$@"
