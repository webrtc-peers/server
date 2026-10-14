set -e
cd "$(dirname "$0")"

host=root@web-play.cn
dir=/root/webroot/webrtc-peers/server
next=$dir.next

# 只传运行需要的文件，依赖在服务器上按 lockfile 装（本地 node_modules 是 Mac 上装的，逐个 scp 又慢）。
# 先在 $next 装好、自检通过再整体换上去，中途失败不影响线上目录
echo '1、上传代码'
ssh $host "rm -rf $next && mkdir -p $next"
scp index.mjs package.json package-lock.json $host:$next/

echo '2、安装依赖并自检'
ssh $host "cd $next && npm ci --omit=dev --no-audit --no-fund && node --check index.mjs && node -e \"require('ws')\""

# systemd 托管（/etc/systemd/system/webrtc-peers.service），TURN_SECRET 在 /etc/webrtc-peers.env。
# 服务把 $dir 只读 bind 进去，换完目录重启才生效；上一版留在 $dir.prev，回滚就换回来再重启
echo '3、切换目录并重启服务'
ssh $host "rm -rf $dir.prev && mv $dir $dir.prev && mv $next $dir && systemctl restart webrtc-peers && sleep 3 && systemctl is-active webrtc-peers"
echo '代码发布完成'
