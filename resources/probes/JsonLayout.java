import java.util.ArrayList;
import java.util.List;

/**
 * 不是探针，是共用类：把探针要写到本地的 JSON 排成能按行读的样子。
 *
 * 规则只有一条：一个值连同它前面的缩进和键，紧凑写法不超过 {@link #WIDTH} 个字符就整个写在一行，
 * 放不下的对象、数组每个成员单独一行（缩进一个制表符），再对每个成员套同一条规则；
 * 超宽的单个字符串没法拆，照原样占一行。只改空白，字符串转义、数字写法、键的顺序原样保留，
 * 所以同一份数据排出来永远一样，两次导出做普通 diff 只出真改动。
 *
 * 和 `src/kernel/json-layout.ts` 是同一条规则的两份实现（那边写本地候选文件），
 * 两边拿 `test/fixtures/json-layout.*` 对齐，改一边要改另一边。
 *
 * 用法：Files.write(path, JsonLayout.layout(SerializeUtils.toJsonString(x)).getBytes(UTF_8))
 */
public final class JsonLayout {

    /** 一行最多放多少字符（按 String.length()）。 */
    public static final int WIDTH = 200;

    private JsonLayout() {
    }

    /** 排版；输入不是合法 JSON 时原样返回。结果末尾带一个换行。 */
    public static String layout(String text) {
        Node tree;
        try {
            Reader reader = new Reader(text);
            tree = reader.value();
            reader.space();
            if (reader.i != text.length()) return text;
        } catch (RuntimeException notJson) {
            return text;
        }
        StringBuilder out = new StringBuilder(text.length() + text.length() / 4);
        lay(tree, 0, 0, out);
        return out.append('\n').toString();
    }

    private static final class Node {
        String scalar;
        char open;
        final List<String> keys = new ArrayList<String>();
        final List<Node> values = new ArrayList<Node>();
        String flat;
    }

    private static void lay(Node node, int depth, int prefix, StringBuilder out) {
        if (node.scalar != null || node.values.isEmpty() || depth + prefix + node.flat.length() <= WIDTH) {
            out.append(node.flat);
            return;
        }
        out.append(node.open).append('\n');
        for (int k = 0; k < node.values.size(); k++) {
            if (k > 0) out.append(",\n");
            tabs(depth + 1, out);
            String key = node.keys.get(k);
            if (key == null) {
                lay(node.values.get(k), depth + 1, 0, out);
            } else {
                out.append(key).append(':');
                lay(node.values.get(k), depth + 1, key.length() + 1, out);
            }
        }
        out.append('\n');
        tabs(depth, out);
        out.append(node.open == '{' ? '}' : ']');
    }

    private static void tabs(int n, StringBuilder out) {
        for (int k = 0; k < n; k++) out.append('\t');
    }

    private static final class Reader {
        private final String s;
        int i;

        Reader(String s) {
            this.s = s;
        }

        void space() {
            while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++;
        }

        Node value() {
            space();
            if (i >= s.length()) throw new IllegalStateException("缺一个值");
            char ch = s.charAt(i);
            if (ch == '{' || ch == '[') return container(ch);
            Node node = new Node();
            if (ch == '"') {
                node.scalar = string();
            } else {
                int start = i;
                while (i < s.length() && ",]}: \t\r\n".indexOf(s.charAt(i)) < 0) i++;
                if (i == start) throw new IllegalStateException("第 " + start + " 个字符不是值");
                node.scalar = s.substring(start, i);
            }
            node.flat = node.scalar;
            return node;
        }

        private Node container(char open) {
            char close = open == '{' ? '}' : ']';
            Node node = new Node();
            node.open = open;
            i++;
            space();
            if (i < s.length() && s.charAt(i) == close) {
                i++;
                node.flat = "" + open + close;
                return node;
            }
            StringBuilder flat = new StringBuilder().append(open);
            for (;;) {
                String key = null;
                if (open == '{') {
                    space();
                    if (i >= s.length() || s.charAt(i) != '"') throw new IllegalStateException("第 " + i + " 个字符应是键");
                    key = string();
                    space();
                    if (i >= s.length() || s.charAt(i) != ':') throw new IllegalStateException("第 " + i + " 个字符应是冒号");
                    i++;
                }
                Node value = value();
                if (!node.values.isEmpty()) flat.append(',');
                if (key != null) flat.append(key).append(':');
                flat.append(value.flat);
                node.keys.add(key);
                node.values.add(value);
                space();
                if (i >= s.length()) throw new IllegalStateException("没有收尾");
                char next = s.charAt(i++);
                if (next == ',') continue;
                if (next == close) {
                    node.flat = flat.append(close).toString();
                    return node;
                }
                throw new IllegalStateException("第 " + (i - 1) + " 个字符应是逗号或 " + close);
            }
        }

        private String string() {
            int start = i;
            i++;
            while (i < s.length() && s.charAt(i) != '"') i += s.charAt(i) == '\\' ? 2 : 1;
            if (i >= s.length()) throw new IllegalStateException("字符串没有收尾");
            i++;
            return s.substring(start, i);
        }
    }
}
