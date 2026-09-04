# -*- coding: utf-8 -*-
# 临时：修 verify.mjs 引号冲突（执行后删）
import os, glob, re

BASE = "scripts/eval/tasks"
for d in sorted(glob.glob(os.path.join(BASE, "t*"))):
    verify = os.path.join(d, "verify.mjs")
    if not os.path.exists(verify):
        continue
    s = open(verify, encoding="utf-8").read()
    # 替换所有 console.error('FAIL:...嵌入值...') 为 console.error('FAIL')
    s = re.sub(r"console\.error\(.FAIL[^)]*\)\",?)", "console.error('FAIL')", s)
    # 也匹配双引号版
    s = re.sub(r'console\.error\("FAIL[^"]*"\)', "console.error('FAIL')", s)
    open(verify, "w", encoding="utf-8").write(s)
    print(f"  {os.path.basename(d)}")
print("Done")
