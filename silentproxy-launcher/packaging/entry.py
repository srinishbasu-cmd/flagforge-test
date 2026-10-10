"""PyInstaller entry point (the package's __main__ uses relative imports)."""
import sys

from silentproxy.cli import main

sys.exit(main())
