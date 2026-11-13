package kd.bos.service.bootstrap;

/**
 * 探针宿主专用的平台启动入口替身：只在探针进程里，排在平台包前面。
 *
 * 苍穹开发助手生成的启动器（老模板的 Launcher、新模板的 CosmicLauncher）都是先把系统属性设好，
 * 最后在 start() 里调 Booter.main(null) 起服务。新模板把配置和 start() 写在同一个 main 里，
 * 没有「只配置、不启动」的方法可调；宿主就直接调工程自己的 main，配置照工程写的原样跑一遍，
 * 走到这里停下、什么都不起。
 *
 * 只替这一个入口：平台里调 Booter 的只有启动服务的那几处（Main、JettyServer），探针一处都不走。
 * 调试节点、部署出去的服务不带探针目录，用的仍是平台原件。
 */
public class Booter {

    /** 走到过这里就记一笔：宿主据此判断工程的 main 确实停在了「起服务」这一步 */
    public static final String REACHED = "cosmic.bootReached";

    public static void main(String[] args) {
        System.setProperty(REACHED, "true");
    }
}
