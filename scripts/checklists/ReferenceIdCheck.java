import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.metadata.dynamicobject.DynamicObjectType;
import kd.bos.dataentity.metadata.dynamicobject.DynamicSimpleProperty;
import kd.bos.entity.property.BasedataProp;

/** 用真实 SDK 制造对象与外键分离；不启动苍穹、不连库。 */
public class ReferenceIdCheck {
    /** SDK 提供的日志工厂插口：离线样本不初始化配置中心。 */
    public static class LocalLogFactory extends kd.bos.logging.LogFactory {
        protected kd.bos.logging.Log _getLog(String name) {
            return (kd.bos.logging.Log) java.lang.reflect.Proxy.newProxyInstance(
                    kd.bos.logging.Log.class.getClassLoader(), new Class<?>[]{kd.bos.logging.Log.class},
                    (proxy, method, args) -> method.getReturnType() == boolean.class ? false : null);
        }
    }
    public static void main(String[] args) {
        DynamicObjectType refType = new DynamicObjectType("ref");
        DynamicSimpleProperty id = new DynamicSimpleProperty("id", Long.class, 0L);
        id.setPrimaryKey(true);
        refType.registerSimpleProperty(id);
        refType.registerProperty("number", String.class, "", false);
        DynamicObjectType billType = new DynamicObjectType("bill");
        BasedataProp base = new BasedataProp();
        base.setName("base");
        base.setComplexType(refType);
        billType.registerComplexProperty(base);
        DynamicSimpleProperty fk = new DynamicSimpleProperty("base_id", Long.class, 0L);
        billType.registerSimpleProperty(fk);
        base.setRefIdProp(fk);
        DynamicObject ref = new DynamicObject(refType);
        ref.set("id", 101L);
        ref.set("number", "A");
        DynamicObject bill = new DynamicObject(billType);
        bill.set("base", ref);
        bill.set("base_id", 101L);
        ExpectSpec.converted(true, "", java.util.Arrays.asList(bill), "base=A");
        int before = ProbeAssert.failCount();
        bill.set("base_id", 202L);
        System.out.println("BASELINE_OBJECT_ONLY=" + ExpectSpec.render(bill.get("base")));
        ExpectSpec.showValue(bill, ExpectSpec.Pos.parse("base"));
        ExpectSpec.converted(true, "", java.util.Arrays.asList(bill), "base=A");
        if (before != 0 || ProbeAssert.failCount() != 1) throw new AssertionError("对象与外键不一致必须恰好多一条失败");
        System.out.println("REFERENCE_ID_CHECK_OK");
    }
}
