import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * S54 的尺子：数苍穹库里有多少类直接引用具体类 kd.bos.mvc.form.ClientViewProxy（强转、按具体类调）。
 * 这些类拿到 run form 原来那种动态代理通道就 ClassCastException。kd/bos/mvc/ 自己的类不算。
 *
 * 用法（JDK 8 即可，不依赖苍穹库）：
 *   javac -encoding UTF-8 -d <输出目录> scripts/s54/ClientViewProxyCasts.java
 *   java -cp <输出目录> ClientViewProxyCasts <苍穹 lib/biz> <苍穹 lib/bos>
 * 基线（2026-10-10，本机 mservice-cosmic 8.0）：49 个 jar、88 个类。
 */
public class ClientViewProxyCasts {
    public static void main(String[] dirs) throws Exception {
        byte[] needle = "kd/bos/mvc/form/ClientViewProxy;".getBytes();
        byte[] needle2 = "\u0000\u001fkd/bos/mvc/form/ClientViewProxy".getBytes("ISO-8859-1");
        int classes = 0;
        Map<String, Integer> per = new TreeMap<String, Integer>();
        StringBuilder sample = new StringBuilder();
        for (String dir : dirs) {
            File[] files = new File(dir).listFiles();
            if (files == null) {
                continue;
            }
            for (File f : files) {
                if (!f.getName().endsWith(".jar")) {
                    continue;
                }
                int c = 0;
                try (ZipFile z = new ZipFile(f)) {
                    for (Enumeration<? extends ZipEntry> e = z.entries(); e.hasMoreElements();) {
                        ZipEntry en = e.nextElement();
                        String n = en.getName();
                        if (!n.endsWith(".class") || n.startsWith("kd/bos/mvc/")) {
                            continue;
                        }
                        byte[] b = readAll(z.getInputStream(en));
                        if (indexOf(b, needle2) >= 0 || indexOf(b, needle) >= 0) {
                            c++;
                            if (sample.length() < 3000) {
                                sample.append(n).append('\n');
                            }
                        }
                    }
                } catch (IOException ignore) {
                    // 坏 jar 跳过
                }
                if (c > 0) {
                    classes += c;
                    per.put(f.getName(), c);
                }
            }
        }
        System.out.println("jars=" + per.size() + " classes=" + classes);
        for (Map.Entry<String, Integer> en : per.entrySet()) {
            System.out.println(en.getKey() + " " + en.getValue());
        }
        System.out.println("---\n" + sample);
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            o.write(buf, 0, n);
        }
        return o.toByteArray();
    }

    static int indexOf(byte[] h, byte[] n) {
        outer:
        for (int i = 0; i <= h.length - n.length; i++) {
            for (int j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
