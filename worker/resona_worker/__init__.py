"""Resona audio restoration worker.

The worker is a stand-alone Python process that is spawned by the Resona desktop
application (or used directly from the command line). It communicates through
newline-delimited JSON messages written to stdout; human-readable logs go to
stderr so they never corrupt the protocol stream.
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = 1
