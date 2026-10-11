"""pi-team（pi 多会话协作工具）的数量词检查配置。

结构与本工具的首个使用方（~/.pi）不同：这是个 TS 代码仓库，可枚举集合来自扩展注册处
（`pi.registerTool` / `pi.registerCommand` 调用数）与 skills 目录，而不是文档结构。
"""

import json
import pathlib
import re

ROOTS = ['README.md', 'pi-peer', 'pi-work-orders', '.count-check']

EXTS = {'.md', '.ts', '.mjs', '.json', '.yaml', '.yml', '.py'}

SKIP_PARTS = {
    'node_modules', 'dist', 'build', '.git', 'evidence', '.work-orders',
    '__pycache__', '.venv', 'venv', 'target',
}

SET_NOUNS = ('接口|表|键|页|类型|档|形态|角色|字段|动作|状态|脚本|检查项|命令|目录|文件|包|模块|段'
             '|阶段|步骤|服务|组件|维度|参数|选项|场景|用例|约定|主题|能力'
             '|工具|会话|消息|事件|工单|扩展|开关|模式|层级|检查|条目|项|轮次|角色卡')


def counts(root):
    """现场解析：集合从扩展注册处数，不手写。"""
    root = pathlib.Path(root)

    def text(rel):
        return (root / rel).read_text(encoding='utf-8')

    peer = text('pi-peer/index.ts')
    work = text('pi-work-orders/index.ts')
    skills = sorted(path.parent.name for path in (root / 'pi-work-orders/skills').glob('*/SKILL.md'))
    manifest = json.loads(text('package.json'))
    roles = text('pi-work-orders/core/types.ts').split('export const ROLES')[1].split('] as const')[0]

    return {
        '包': (len([path for path in root.glob('pi-*') if path.is_dir()]), '根目录下的 pi-* 包目录'),
        '扩展': (len(manifest['pi']['extensions']), 'package.json 的 pi.extensions 数组'),
        '状态': (len(re.findall(r'"\w+"', roles)), 'core/types.ts 的 ROLES（默认状态集）'),
        # 要求行首（可带缩进）直接是调用：注释掉的那行前缀是 `//`，不该计入基数 ——
        # 不这么写的话，把一处注册注释掉，基数不变、判据照样绿（实测踩到）。
        'peer 工具': (len(re.findall(r'^[ \t]*pi\.registerTool\(', peer, re.M)), 'pi-peer/index.ts 的 registerTool 调用'),
        'peer 命令': (len(re.findall(r'^[ \t]*pi\.registerCommand\(', peer, re.M)), 'pi-peer/index.ts 的 registerCommand 调用'),
        '工单工具': (len(re.findall(r'^[ \t]*pi\.registerTool\(', work, re.M)), 'pi-work-orders/index.ts 的 registerTool 调用'),
        '工单命令': (len(re.findall(r'^[ \t]*pi\.registerCommand\(', work, re.M)), 'pi-work-orders/index.ts 的 registerCommand 调用'),
        'skill': (len(skills), 'pi-work-orders/skills/*/SKILL.md'),
    }


# 「工具」「命令」在语料里都指得到两个集合（peer 的与工单的），是歧义词：
# 清单判 ok 时必须写 `ok@集合名` 点明核的是哪个，否则报 UNRESOLVED。
WORDS = {
    '工具': ('peer 工具', '工单工具'),
    '命令': ('peer 命令', '工单命令'),
    'skill': ('skill',),
    '包': ('包',),
    '扩展': ('扩展',),
    '状态': ('状态',),
}
