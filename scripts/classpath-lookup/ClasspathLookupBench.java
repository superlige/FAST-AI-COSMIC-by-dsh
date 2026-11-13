import java.io.File;
import java.net.InetAddress;
import java.net.URL;
import java.util.Arrays;

/**
 * scripts/measure-classpath-lookup.ts 起的冷进程：量在这条类路径上找一个类要多久。
 * 不进苍穹、不连任何环境，只碰类加载器。
 */
public class ClasspathLookupBench {
    public static void main(String[] args) throws Exception {
        ClassLoader loader = ClasspathLookupBench.class.getClassLoader();
        String hit = args.length > 0 ? args[0] : "kd.bos.form.FormShowParameter";
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 200;
        if (args.length > 2 && "index".equals(args[2])) {
            long started = System.nanoTime();
            System.out.println("先给每个包登记「里面有哪些顶层目录」：" + registerIndex() + "，用了 " + ms(System.nanoTime() - started) + " 毫秒");
        }

        long t = System.nanoTime();
        boolean found = loader.getResource("no/such/pkg/First.class") != null;
        System.out.println("第一次找一个不存在的类（要把类路径上的包全打开）：" + ms(System.nanoTime() - t) + " 毫秒" + (found ? "（竟然找到了）" : ""));

        long[] miss = new long[rounds];
        for (int i = 0; i < rounds; i++) {
            long s = System.nanoTime();
            loader.getResource("no/such/pkg/Miss" + i + ".class");
            miss[i] = System.nanoTime() - s;
        }
        System.out.println("之后找不存在的类 " + rounds + " 次：中位 " + ms(median(miss)) + " 毫秒一次");

        long[] forName = new long[rounds];
        for (int i = 0; i < rounds; i++) {
            long s = System.nanoTime();
            try {
                Class.forName("no.such.pkg.Klass" + i + "BeanInfo", false, loader);
            } catch (ClassNotFoundException expected) {
                //量的就是找不到
            }
            forName[i] = System.nanoTime() - s;
        }
        System.out.println("Class.forName 一个不存在的类 " + rounds + " 次：中位 " + ms(median(forName)) + " 毫秒一次");

        String resource = hit.replace('.', '/') + ".class";
        long[] hits = new long[rounds];
        URL where = null;
        for (int i = 0; i < rounds; i++) {
            long s = System.nanoTime();
            where = loader.getResource(resource);
            hits[i] = System.nanoTime() - s;
        }
        System.out.println("找一个存在的类 " + hit + " " + rounds + " 次：中位 " + ms(median(hits)) + " 毫秒一次；在 "
                + (where == null ? "（没找到）" : new File(where.getPath().replaceAll("!.*$", "")).getName()));

        t = System.nanoTime();
        InetAddress local = InetAddress.getLocalHost();
        long resolve = System.nanoTime() - t;
        t = System.nanoTime();
        String canonical = local.getCanonicalHostName();
        System.out.println("本机名 " + local.getHostName() + "（" + local.getHostAddress() + "）：取本机地址 " + ms(resolve)
                + " 毫秒，按地址反查主机名 " + ms(System.nanoTime() - t) + " 毫秒，查到 " + canonical);

        //平台带的 ClickHouse 驱动初始化时做的事：每块网卡的每个非回环地址都反查一次主机名。跑两遍，看第二遍有没有人替它记着
        for (int pass = 1; pass <= 2; pass++) {
        long all = System.nanoTime();
        int count = 0;
        for (java.net.NetworkInterface card : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
            for (InetAddress address : java.util.Collections.list(card.getInetAddresses())) {
                if (address.isLoopbackAddress()) continue;
                long s = System.nanoTime();
                String name = address.getCanonicalHostName();
                long took = System.nanoTime() - s;
                count++;
                if (took > 50_000_000L) {
                    System.out.println("  反查 " + address.getHostAddress() + "（" + card.getDisplayName() + "）" + ms(took) + " 毫秒 → " + name);
                }
            }
        }
        System.out.println("第 " + pass + " 遍把每块网卡的每个地址都反查一遍主机名：" + count + " 个地址，共 " + ms(System.nanoTime() - all) + " 毫秒");
        }
    }

    /**
     * 试验：JDK 8 找类时，登记过目录清单的包先比一下名字开头，对不上就不打开、不翻。
     * 清单按包里真实的条目现算（取前两层目录），自带 Class-Path 的包不登记（登记了 JDK 就不再读它的 Class-Path）。
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static String registerIndex() throws Exception {
        Class<?> metaIndex = Class.forName("sun.misc.MetaIndex");
        java.lang.reflect.Method getJarMap = metaIndex.getDeclaredMethod("getJarMap");
        getJarMap.setAccessible(true);
        java.util.Map jarMap = (java.util.Map) getJarMap.invoke(null);
        java.lang.reflect.Constructor<?> create = metaIndex.getDeclaredConstructor(java.util.List.class, boolean.class);
        create.setAccessible(true);
        int registered = 0;
        int skipped = 0;
        int prefixes = 0;
        java.util.List<String> path = new java.util.ArrayList<String>();
        for (String entry : System.getProperty("java.class.path").split(File.pathSeparator)) {
            path.add(entry);
            if (!entry.endsWith(".jar")) continue;
            //pathing jar：真正的类路径写在它的 Class-Path 里
            try (java.util.jar.JarFile jar = new java.util.jar.JarFile(entry)) {
                java.util.jar.Manifest manifest = jar.getManifest();
                String more = manifest == null ? null : manifest.getMainAttributes().getValue("Class-Path");
                if (more == null) continue;
                for (String url : more.trim().split("\\s+")) {
                    if (url.startsWith("file:")) path.add(new File(new java.net.URI(url)).getPath());
                }
            }
        }
        for (String entry : path) {
            File file = new File(entry);
            if (!entry.endsWith(".jar") || !file.isFile()) continue;
            java.util.TreeSet<String> tops = new java.util.TreeSet<String>();
            boolean hasClassPath;
            try (java.util.jar.JarFile jar = new java.util.jar.JarFile(file)) {
                java.util.jar.Manifest manifest = jar.getManifest();
                hasClassPath = manifest != null && manifest.getMainAttributes().getValue("Class-Path") != null;
                java.util.Enumeration<java.util.jar.JarEntry> all = jar.entries();
                while (all.hasMoreElements()) {
                    String name = all.nextElement().getName();
                    int first = name.indexOf('/');
                    if (first < 0) {
                        tops.add(name);
                        continue;
                    }
                    int second = name.indexOf('/', first + 1);
                    tops.add(second < 0 ? name.substring(0, first + 1) : name.substring(0, second + 1));
                }
            }
            if (hasClassPath) {
                skipped++;
                continue;
            }
            jarMap.put(file, create.newInstance(new java.util.ArrayList<String>(tops), false));
            registered++;
            prefixes += tops.size();
        }
        return "登记 " + registered + " 个包、共 " + prefixes + " 个开头，自带 Class-Path 没登记的 " + skipped + " 个";
    }

    private static long median(long[] values) {
        long[] sorted = values.clone();
        Arrays.sort(sorted);
        return sorted[sorted.length / 2];
    }

    private static String ms(long nanos) {
        return String.format("%.2f", nanos / 1e6);
    }
}
