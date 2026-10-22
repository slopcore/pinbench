Import("env")
import os

runtime_dir = os.environ.get("PINBENCH_RUNTIME_DIR", "")
if not runtime_dir:
    runtime_dir = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""

shim_dir = os.path.join(runtime_dir, "pinbench-wifi-shim")
shim_src_dir = os.path.join(shim_dir, "src")
shim_inc_dir = os.path.join(shim_dir, "include")

if os.path.isdir(shim_src_dir):
    if os.path.isdir(shim_inc_dir):
        env.Append(CPPPATH=[shim_inc_dir])
    lib = env.BuildLibrary(
        os.path.join("$BUILD_DIR", "pinbench_wifi_shim"),
        shim_src_dir
    )
    env.Prepend(LIBS=[lib])
