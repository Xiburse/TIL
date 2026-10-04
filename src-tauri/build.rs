fn main() {
    // 为什么不用默认的 tauri_build::build()：
    //
    // 它只把应用清单（声明 Common Controls v6 依赖）嵌进**主二进制**，测试
    // 可执行文件没有。缺了清单，加载器解析不了 comctl32 的 SxS 依赖，测试进程
    // 会在跑任何一条用例之前就以 STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) 挂掉
    // —— 报错看着像链接问题，其实是清单问题，很难查。
    //
    // 所以这里让 tauri-build **别**自己嵌清单，改由 embed-resource 给所有目标
    // 统一嵌同一份。只有一个来源，就不会出现「重复嵌清单导致链接器报错」。
    //
    // 上游曾有过 __TAURI_WORKSPACE__=true 的临时开关，但已被移除（tauri 提交
    // 84b2dcfe）。`rustc-link-arg-tests` 也不行 —— cargo 不把这个 lib 目标
    // 认作 test target。
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("tauri-build 失败");

    #[cfg(windows)]
    {
        println!("cargo::rerun-if-changed=windows-app.manifest");
        let _ = embed_resource::compile_for_everything("windows-app.rc", embed_resource::NONE);
    }
}
