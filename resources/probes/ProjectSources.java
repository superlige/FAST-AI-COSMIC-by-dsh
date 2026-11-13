import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 不是探针，是共用类：在本工程源码里找类、找标识。
 *
 * 探针进程的工作目录就是工程根，业务源码在各模块的 src/main/java 下。只读源码文本、不加载类：
 * 环境里部署的可能是旧版，要改的是工程里这一份。
 */
public final class ProjectSources {

    private static List<File> roots;
    /** 工程里所有 `static final String X = "…"` 常量：值 → 常量名。第一次用到时扫一遍。 */
    private static Map<String, Set<String>> constants;

    private static final Pattern CONSTANT =
            Pattern.compile("\\b(?:static\\s+final|final\\s+static)\\s+String\\s+(\\w+)\\s*=\\s*\"([^\"\\\\]*)\"\\s*;");
    private static final Pattern METHOD =
            Pattern.compile("^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|protected|private|static|final|synchronized)\\s+)+[\\w<>\\[\\],.? ]+\\s+(\\w+)\\s*\\(");

    private ProjectSources() {
    }

    static List<File> roots() {
        if (roots == null) {
            roots = new ArrayList<File>();
            collect(new File("."), 0);
        }
        return roots;
    }

    private static void collect(File dir, int depth) {
        File java = new File(dir, "src/main/java");
        if (java.isDirectory()) roots.add(java);
        if (depth >= 3) return;
        File[] subs = dir.listFiles(File::isDirectory);
        if (subs == null) return;
        for (File d : subs) {
            String n = d.getName();
            if (n.startsWith(".") || n.equals("build") || n.equals("src") || n.equals("node_modules") || n.equals("outputs")) continue;
            collect(d, depth + 1);
        }
    }

    /** 类全名对应的源码文件（相对工程根），工程里没有返回 null。 */
    static String of(String cls) {
        String rel = cls.replace('.', '/') + ".java";
        for (File r : roots()) {
            File f = new File(r, rel);
            if (f.isFile()) return f.getPath().replace('\\', '/').replaceFirst("^\\./", "");
        }
        return null;
    }

    /** 这几个类的源码里，哪几行写着带引号的这个标识（注释行不算）。 */
    static List<String> mentions(Set<String> classes, String key) {
        List<String> out = new ArrayList<String>();
        String needle = "\"" + key + "\"";
        for (String cls : classes) {
            String path = cls == null ? null : of(cls);
            if (path == null) continue;
            try {
                List<String> lines = Files.readAllLines(new File(path).toPath(), StandardCharsets.UTF_8);
                for (int i = 0; i < lines.size(); i++) {
                    if (comment(lines.get(i))) continue;
                    if (lines.get(i).contains(needle)) out.add("插件 " + path + " 第 " + (i + 1) + " 行");
                }
            } catch (Exception e) {
                out.add("插件 " + path + " 读不了（" + e.getClass().getSimpleName() + "），没查");
            }
        }
        return out;
    }

    /** 源码里用到某个标识的一行。 */
    static final class Use {
        final String path;
        final int line;
        /** 这一行所在的方法；往上找不到方法声明时为 null。 */
        final String method;
        final String key;

        Use(String path, int line, String method, String key) {
            this.path = path;
            this.line = line;
            this.method = method;
            this.key = key;
        }
    }

    /**
     * 这几个类的源码里，哪几行用到了这些标识：带引号的字面量，或者值正好是它的字符串常量
     * （常量定义在工程里哪个类都算，写成 `X` 或 `Con.X` 都认）。注释行不算。
     * 读不了的文件记在 unreadable 里。
     */
    static List<Use> uses(Collection<String> classes, Collection<String> keys, List<String> unreadable) {
        Map<String, Pattern> names = new HashMap<String, Pattern>();
        for (String key : keys) {
            Set<String> byValue = constants().get(key);
            if (byValue != null) names.put(key, Pattern.compile("\\b(?:" + String.join("|", byValue) + ")\\b"));
        }
        List<Use> out = new ArrayList<Use>();
        for (String cls : classes) {
            String path = of(cls);
            if (path == null) continue;
            List<String> lines;
            try {
                lines = Files.readAllLines(new File(path).toPath(), StandardCharsets.UTF_8);
            } catch (Exception e) {
                unreadable.add(path);
                continue;
            }
            for (int i = 0; i < lines.size(); i++) {
                String text = lines.get(i);
                if (comment(text)) continue;
                for (String key : keys) {
                    if (text.contains("\"" + key + "\"") || usesConstant(text, names.get(key))) {
                        out.add(new Use(path, i + 1, methodAt(lines, i), key));
                        break;
                    }
                }
            }
        }
        return out;
    }

    /** 用到值相同的常量；常量自己的声明行不算。 */
    private static boolean usesConstant(String text, Pattern names) {
        return names != null && names.matcher(text).find() && !CONSTANT.matcher(text).find();
    }

    private static String methodAt(List<String> lines, int index) {
        for (int i = index; i >= 0; i--) {
            Matcher m = METHOD.matcher(lines.get(i));
            if (m.find() && !lines.get(i).contains(" new ") && !lines.get(i).trim().startsWith("return")) return m.group(1);
        }
        return null;
    }

    private static boolean comment(String line) {
        String t = line.trim();
        return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
    }

    private static Map<String, Set<String>> constants() {
        if (constants != null) return constants;
        constants = new HashMap<String, Set<String>>();
        for (File root : roots()) scan(root);
        return constants;
    }

    private static void scan(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) {
                scan(f);
                continue;
            }
            if (!f.getName().endsWith(".java")) continue;
            try {
                for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                    if (!line.contains("String") || comment(line)) continue;
                    Matcher m = CONSTANT.matcher(line);
                    while (m.find()) {
                        Set<String> names = constants.get(m.group(2));
                        if (names == null) constants.put(m.group(2), names = new LinkedHashSet<String>());
                        names.add(m.group(1));
                    }
                }
            } catch (Exception ignored) {
                // 编码不对的文件没有常量可取，跳过
            }
        }
    }
}
