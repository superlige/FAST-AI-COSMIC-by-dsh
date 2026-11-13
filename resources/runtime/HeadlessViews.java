package cosmic.headless;

import java.util.List;
import java.util.function.BiFunction;

import kd.bos.form.FormShowParameter;
import kd.bos.form.IFormView;
import kd.bos.list.BillList;
import kd.bos.mvc.base.BaseView;
import kd.bos.mvc.bill.BillView;
import kd.bos.mvc.bill.MobileBillView;
import kd.bos.mvc.form.FormView;
import kd.bos.mvc.form.MobileFormView;
import kd.bos.mvc.list.ListView;
import kd.bos.mvc.list.MobileListView;

/**
 * 宿主自带的无头视图，不是探针：FormSim、FormCallbackSim、ListSim 起表单、单据、基础资料、列表都用这里的类。
 *
 * <p>为什么放在宿主、为什么要有包名：平台的脚本插件（{@code KDFormPlugin} 包着的那类）拿到视图对象时，
 * 脚本引擎按类名 {@code Class.forName} 找它的类，再读它的包名生成包装类。
 * 探针类由常驻进程每次新建的类加载器装，平台那一侧按名字找不到；默认包的类 {@code getPackage()} 又是 null，
 * 脚本引擎当场空指针。两样都会让脚本插件在绑定数据时抛错，排在它后面的插件这一步全没跑到。
 * 这里的类由系统类加载器装、在命名包里，脚本引擎拿它当平台自己的视图用。
 *
 * <p>探针要定制的几处走 {@link #hook}，探针每次运行前设好，这里只转发：
 * <ul>
 * <li>{@code initiService(view)}：平台建服务之前（放页面缓存——原厂建发往浏览器的通道时就要用它，缺了构造函数里 NPE）；</li>
 * <li>{@code addService(view, 类型, 服务)}：返回要放进去的服务，null 表示照原样放（换发往浏览器的通道用）；</li>
 * <li>{@code showForm(view, 参数)}：平台弹出子页之后（记下弹了什么）；</li>
 * <li>{@code parentView(view)}：列表没有父页时给一个兜底的父页。</li>
 * </ul>
 * 探针串行执行，静态钩子不会两次运行混用。
 */
public final class HeadlessViews {

    public static volatile BiFunction<String, Object[], Object> hook;

    private HeadlessViews() {
    }

    static Object call(String what, Object... args) {
        BiFunction<String, Object[], Object> h = hook;
        return h == null ? null : h.apply(what, args);
    }

    /** 三种视图共用的口子：initiPluginProxy / getPluginProxy 在 FormView 上是 protected。 */
    public interface Page {
        void ensurePluginProxy();

        Object pluginProxy();
    }

    static Object service(Object view, Class<?> clazz, Object service) {
        Object swapped = call("addService", view, clazz, service);
        return swapped == null ? service : swapped;
    }

    /** 动态表单。 */
    public static class Form extends FormView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public void showForm(FormShowParameter parameter) {
            super.showForm(parameter);
            call("showForm", this, parameter);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }

    /** 单据。 */
    public static class Bill extends BillView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public void showForm(FormShowParameter parameter) {
            super.showForm(parameter);
            call("showForm", this, parameter);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }

    /** 基础资料。 */
    public static class Base extends BaseView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public void showForm(FormShowParameter parameter) {
            super.showForm(parameter);
            call("showForm", this, parameter);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }

    /** 移动表单：平台按打开参数配移动端表单视图（自己的控制器、插件代理，实现 IMobileView），移动端插件按它来。 */
    public static class MobileForm extends MobileFormView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public void showForm(FormShowParameter parameter) {
            super.showForm(parameter);
            call("showForm", this, parameter);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }

    /** 移动单据（单据带的移动端页面 <单据>_mob，或独立的移动单据）：平台按打开参数配移动端单据视图（自己的控制器、插件代理，实现 IMobileView），移动端插件按它来。 */
    public static class MobileBill extends MobileBillView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public void showForm(FormShowParameter parameter) {
            super.showForm(parameter);
            call("showForm", this, parameter);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }

    /** 列表。 */
    public static class ListPage extends ListView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public IFormView getParentView() {
            IFormView parent = super.getParentView();
            return parent != null ? parent : (IFormView) call("parentView", this);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }

        /**
         * 界面上在筛选栏里换主组织之后平台做的那两步：记下选的组织，按它重算列表的主组织条件
         * （字段用哪个、要不要按权限维度算，都是平台自己的那段代码定）。
         */
        public void chooseMainOrgs(BillList list, List<Long> ids) {
            setSelectedMainOrgIds(ids);
            setBillListFilterParameter(list);
        }
    }

    /** 移动端列表：平台按移动端列表的打开参数配这个视图（自己的控制器、插件代理），移动端列表插件按它来。 */
    public static class MobileListPage extends MobileListView implements Page {
        @Override
        protected void initiService() {
            call("initiService", this);
            super.initiService();
        }

        @Override
        public void addService(Class<?> clazz, Object service) {
            super.addService(clazz, service(this, clazz, service));
        }

        @Override
        public IFormView getParentView() {
            IFormView parent = super.getParentView();
            return parent != null ? parent : (IFormView) call("parentView", this);
        }

        @Override
        public void ensurePluginProxy() {
            if (getPluginProxy() == null) {
                initiPluginProxy();
            }
        }

        @Override
        public Object pluginProxy() {
            return getPluginProxy();
        }
    }
}
