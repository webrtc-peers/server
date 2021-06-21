 

echo '1、代码上传'

message="cd /root/webroot/webrtc-peers/server && rm -rf *"

echo '2、执行远程命令：' "$message"
ssh root@web-play.cn "$message"

echo '3、传送'
scp -r ./* root@web-play.cn:/root/webroot/webrtc-peers/server

echo '代码发布完成'
