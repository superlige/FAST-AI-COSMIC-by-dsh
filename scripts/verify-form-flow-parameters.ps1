# 同单据复测父子页参数和异常项目回写，不执行保存。
param([string]$Project = 'D:/kingdee/zlgd_ygpt2.0')
$runArgs = 'flow zlgd_sys_test_zdgpfx --pk 2608933980103258112 --op zlgd_jgyc_gp --child zlgd_ycysxz --set zlgd_entryentity_gp[3].zlgd_femn=0.35 --set zlgd_entryentity_gp[4].zlgd_femn=0.55 --select zlgd_entryentity_gp=3,4 --child-set zlgd_muljyxm=JCXM-CF01-019 --child-click btnok --expect zlgd_jgycxm_gp=JCXM-CF01-019 --expect zlgd_entryentity_gp3[0].zlgd_femn2=0.35、0.55 --expect zlgd_entryentity_gp3[1].zlgd_femn2=0.35、0.55'
node --experimental-strip-types "$PSScriptRoot/measure-probe-view.ts" --project $Project --run $runArgs
exit $LASTEXITCODE
