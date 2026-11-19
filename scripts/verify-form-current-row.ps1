# 同一检测单的当前行、合计、平均及修约回归；只运行计算，不保存。
param([string]$Project = 'D:/kingdee/zlgd_ygpt2.0')
$runArgs = 'form zlgd_sys_test_zdgpfx --pk 2608933980103258112 --set zlgd_entryentity_gp[3].zlgd_fe=0.12 --set zlgd_entryentity_gp[3].zlgd_mn=0.23 --set zlgd_entryentity_gp[4].zlgd_ypbh_hxfx1=1-1 --set zlgd_entryentity_gp[4].zlgd_srcentryid=2608932373902929921 --set zlgd_entryentity_gp[4].zlgd_fe=0.22 --set zlgd_entryentity_gp[4].zlgd_mn=0.33 --op calzdgpfx --expect zlgd_entryentity_gp[0].zlgd_femn=李俊龙 --expect zlgd_entryentity_gp[3].zlgd_femn=0.35 --expect zlgd_entryentity_gp[4].zlgd_femn=0.55 --expect zlgd_entryentity_gp3[0].zlgd_femn2=0.45 --expect zlgd_entryentity_gp3[1].zlgd_femn2=0.45'
node --experimental-strip-types "$PSScriptRoot/measure-probe-view.ts" --project $Project --run $runArgs
exit $LASTEXITCODE
