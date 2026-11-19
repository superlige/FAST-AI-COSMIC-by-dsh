import java.util.ArrayList;
import java.util.List;

import kd.bos.entity.botp.runtime.ConvertOperationResult;
import kd.bos.entity.botp.runtime.SourceBillReport;

/**
 * 不是探针，是共用类：一次下推的提示文字，日志和断言用同一份。
 *
 * <p>平台把原因分两处放：{@link ConvertOperationResult#getMessage()} 是总提示，常常是 null；
 * 每张源单没推成的原因在 {@link SourceBillReport#getFailMessages()} 里
 * （真机 2026-11-17：重复下推被拦，总提示 null，逐单里是「已有下游…存在，请勿重复下推」）。
 * 只读总提示，断言 `message=` 就拿到空值。所以两处按先总后逐单拼起来，逐单的前面带源单编号，
 * 看得出是哪张单报的。</p>
 */
public final class ConvertMessage {

    private ConvertMessage() {
    }

    /** 总提示加上每张源单没推成的原因，`；` 分隔；两处都没有就是空串。 */
    public static String of(ConvertOperationResult result) {
        List<String> out = new ArrayList<String>();
        if (result == null) {
            return "";
        }
        String total = result.getMessage();
        if (total != null && !total.trim().isEmpty()) {
            out.add(total.trim());
        }
        if (result.getBillReports() != null) {
            for (SourceBillReport r : result.getBillReports()) {
                List<String> fails = r.getFailMessages();
                if (fails == null || fails.isEmpty()) {
                    continue;
                }
                String source = r.getBillNo() != null && !r.getBillNo().trim().isEmpty()
                        ? r.getBillNo().trim()
                        : r.getBillId() == null ? "" : "pk=" + r.getBillId();
                out.add((source.isEmpty() ? "" : "源单 " + source + "：") + String.join("；", fails));
            }
        }
        return String.join("；", out);
    }
}
