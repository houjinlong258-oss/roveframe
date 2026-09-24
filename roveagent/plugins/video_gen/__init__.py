"""Video generation backend plugins (fal / xai / deepinfra / configured).

这个 ``__init__.py`` 的作用不是运行时（插件加载器扫目录，不依赖它），
而是**让 unittest 发现能递归进来**。

背景（实测 2026-09-25）：``scripts/run-python-tests.py`` 用
``unittest discover(pattern="*_test.py")``，而没有 ``__init__.py`` 的目录**不会**被
递归 —— 于是 ``plugins/video_gen/configured/configured_video_test.py`` 明明存在、
单跑通过，却**一个都不会被执行**：守卫等于没写。
``plugins/web/`` 因为恰好有这个文件，它的测试才在跑。

同类目录里两者并存，这里选择与 ``plugins/web/`` 一致：加文件，让守卫真正生效。
"""
