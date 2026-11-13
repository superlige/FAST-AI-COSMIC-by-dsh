import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 读类文件头上的父类和接口，一路往上收齐（不是探针，写探针共用）。只当资源读字节，不定义类、不跑静态块：
 * 写探针要核「登记的这个类是不是该类插件」，但不该为此把业务类装进进程。
 */
final class ClassFiles {
    /** 这个类连同它全部祖先和接口（斜杠写法）；类路径上没有这个类返回 null。 */
    static Set<String> ancestors(String name) {
        Set<String> out = new LinkedHashSet<String>();
        return walk(name, out) ? out : null;
    }

    /** 这个类是不是抽象类或接口（平台按类名建不出它的实例）；类路径上没有这个类返回 false。 */
    static boolean isAbstract(String name) {
        try (java.io.InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(name + ".class")) {
            if (in == null) return false;
            int[] flags = new int[1];
            parents(new java.io.DataInputStream(new java.io.BufferedInputStream(in)), flags);
            return (flags[0] & 0x0600) != 0;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean walk(String name, Set<String> out) {
        if (!out.add(name)) return true;
        String[] parents;
        try (java.io.InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(name + ".class")) {
            if (in == null) return false;
            parents = parents(new java.io.DataInputStream(new java.io.BufferedInputStream(in)), new int[1]);
        } catch (Exception e) {
            return false;
        }
        for (String x : parents) walk(x, out);
        return true;
    }

    /** 类文件格式：常量池之后是访问标志、本类、父类、接口表；返回后两样，访问标志放进 flags[0]。 */
    static String[] parents(java.io.DataInputStream in, int[] flags) throws Exception {
        in.readInt();
        in.readUnsignedShort();
        in.readUnsignedShort();
        int n = in.readUnsignedShort();
        String[] utf8 = new String[n];
        int[] classRef = new int[n];
        for (int i = 1; i < n; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1: utf8[i] = in.readUTF(); break;
                case 7: classRef[i] = in.readUnsignedShort(); break;
                case 8: case 16: case 19: case 20: in.readUnsignedShort(); break;
                case 15: in.readUnsignedByte(); in.readUnsignedShort(); break;
                case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: in.readInt(); break;
                case 5: case 6: in.readLong(); i++; break;
                default: throw new IllegalStateException("认不出的常量池类型 " + tag);
            }
        }
        flags[0] = in.readUnsignedShort();
        in.readUnsignedShort();
        List<String> out = new ArrayList<String>();
        int sup = in.readUnsignedShort();
        if (sup != 0) out.add(utf8[classRef[sup]]);
        int count = in.readUnsignedShort();
        for (int i = 0; i < count; i++) out.add(utf8[classRef[in.readUnsignedShort()]]);
        return out.toArray(new String[0]);
    }
}
