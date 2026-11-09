import importlib

# 1. 定义你的节点文件名列表（不带.py后缀）
# 确保你的代码1文件名为 csv_prompt_picker1.py，并且放在 nodes 文件夹下
node_list = [
    "csv_prompt_picker1"
]

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

for module_name in node_list:
    # 动态导入 nodes 文件夹下的文件
    imported_module = importlib.import_module(".nodes.{}".format(module_name), __name__)

    # 合并节点映射
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **imported_module.NODE_CLASS_MAPPINGS}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **imported_module.NODE_DISPLAY_NAME_MAPPINGS}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]