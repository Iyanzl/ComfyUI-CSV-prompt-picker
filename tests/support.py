"""Load the real node's routes without starting ComfyUI or loading GPU models."""
import importlib.util
import sys
import types
from pathlib import Path
from aiohttp import web

NODE_DIR = Path(__file__).resolve().parents[1]


def load_node(input_directory):
    folders = types.ModuleType("folder_paths")
    folders.get_input_directory = lambda: str(input_directory)
    server = types.ModuleType("server")
    routes = web.RouteTableDef()
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
    sys.modules["folder_paths"] = folders
    sys.modules["server"] = server
    package = types.ModuleType("csv_picker_validation")
    package.__path__ = [str(NODE_DIR / "nodes")]
    sys.modules[package.__name__] = package
    spec = importlib.util.spec_from_file_location("csv_picker_validation.csv_prompt_picker1", NODE_DIR / "nodes/csv_prompt_picker1.py")
    node = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(node)
    app = web.Application(client_max_size=16 * 1024 * 1024)
    app.add_routes(routes)
    return node, app
