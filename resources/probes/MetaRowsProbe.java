import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 只读：把一张单的设计态元数据**原样**取出来——本单、它继承链上的每一层、作用在这些层上的扩展，
 * 实体（t_meta_entitydesign）和布局（t_meta_formdesign）两张表都取，FDATA 全文落成文件。
 *
 * 命令内部用（cosmic_prod action=meta，比对生产和测试时取测试这一侧）。生产那一侧是同样几条 SQL
 * 走只读通道取的，两边落盘的形状一样，由同一段代码合并、比对。
 *
 * 不 readMeta：平台读出来的是合并后的运行时对象，看不出「哪一层加的」；要比的正是每一层的原文。
 *
 *   META_NUMBER  单据、基础资料或布局的标识（只允许字母数字下划线）
 *   META_OUT     落盘目录（必填）。每行一个文件 NN-<编号>.<entity|form>.xml，外加 rows.tsv 索引
 */
public class MetaRowsProbe {

    public static void run() throws Exception {
        final String number = req("META_NUMBER");
        if (!number.matches("[A-Za-z0-9_]+")) throw new IllegalArgumentException("标识形状不合法：" + number);
        File out = new File(req("META_OUT"));
        out.mkdirs();
        long t0 = System.currentTimeMillis();
        Set<String> chain = new LinkedHashSet<String>();
        for (String table : new String[] {"t_meta_entitydesign", "t_meta_formdesign"}) {
            List<String[]> self = rows(table, "fnumber = '" + number + "'");
            for (String[] r : self) {
                for (String id : r[5].split(",")) if (!id.trim().isEmpty()) chain.add(id.trim());
                chain.add(r[0]);
            }
        }
        if (chain.isEmpty()) {
            System.out.println("[PROBE] 测试环境没有标识为 " + number + " 的元数据");
            ProbeJson.emit("meta-rows", "number", number, "rows", 0, "ms", System.currentTimeMillis() - t0);
            return;
        }
        StringBuilder in = new StringBuilder();
        for (String id : chain) {
            if (id.contains("'")) continue;
            in.append(in.length() == 0 ? "" : ",").append('\'').append(id).append('\'');
        }
        StringBuilder index = new StringBuilder("kind\tfid\tfnumber\tfisv\tfparentid\tfmasterid\tfinheritpath\tfmodifydate\tfile\n");
        int n = 0;
        for (String kind : new String[] {"entity", "form"}) {
            String table = "entity".equals(kind) ? "t_meta_entitydesign" : "t_meta_formdesign";
            for (String[] r : rows(table, "fid in (" + in + ") or fmasterid in (" + in + ")")) {
                n++;
                String file = String.format("%02d-%s.%s.xml", n, r[1], kind);
                write(new File(out, file), r[7] == null ? "" : r[7]);
                index.append(kind).append('\t').append(r[0]).append('\t').append(r[1]).append('\t').append(r[2])
                        .append('\t').append(r[3]).append('\t').append(r[4]).append('\t').append(r[5])
                        .append('\t').append(r[6]).append('\t').append(file).append('\n');
            }
        }
        write(new File(out, "rows.tsv"), index.toString());
        System.out.println("[PROBE] " + number + " 取了 " + n + " 行元数据，" + (System.currentTimeMillis() - t0) + "ms → " + out);
        ProbeJson.emit("meta-rows", "number", number, "rows", n, "dir", out.getAbsolutePath(),
                "ms", System.currentTimeMillis() - t0);
    }

    /** fid, fnumber, fisv, fparentid, fmasterid, finheritpath, fmodifydate, fdata */
    private static List<String[]> rows(String table, String where) {
        return DB.query(DBRoute.meta, "select fid, fnumber, fisv, fparentid, fmasterid, finheritpath, fmodifydate, fdata from "
                + table + " where " + where, new ResultSetHandler<List<String[]>>() {
                    public List<String[]> handle(ResultSet rs) throws Exception {
                        List<String[]> list = new ArrayList<String[]>();
                        while (rs.next()) {
                            String[] r = new String[8];
                            for (int i = 0; i < 8; i++) {
                                String v = rs.getString(i + 1);
                                r[i] = v == null ? "" : v.trim();
                            }
                            r[7] = rs.getString(8);
                            list.add(r);
                        }
                        return list;
                    }
                });
    }

    private static void write(File file, String text) throws Exception {
        OutputStream o = new FileOutputStream(file);
        try {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            o.close();
        }
    }

    private static String req(String key) {
        String v = System.getenv(key);
        if (v == null || v.trim().isEmpty()) throw new IllegalArgumentException("需要环境变量 " + key);
        return v.trim();
    }
}
