#!/bin/zsh
PLUGIN_DIR="${0:A:h}"
open -a 'Google Chrome' 'chrome://extensions'
echo ''
echo 'Chrome 扩展管理页已打开。'
echo '请开启右上角“开发者模式”，点击“加载已解压的扩展程序”，然后选择：'
echo "$PLUGIN_DIR"
read '?完成后按回车关闭此窗口。'
