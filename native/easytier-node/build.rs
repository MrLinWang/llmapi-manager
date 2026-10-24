fn main() {
    // napi-rs 的构建期配置：生成链接参数与 Node 版本相关的宏。
    // 对应 ref/EasyTier/easytier-contrib/easytier-ohrs/build.rs（那边调的是
    // napi_build_ohos::setup()，这里换成上游 napi-rs 的 napi_build::setup()）。
    napi_build::setup();
}
