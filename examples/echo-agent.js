#!/usr/bin/env node
/**
 * 最小的 cli 驱动示例。
 *
 * 它做的事只有一件：把群里最后一句「主人」说的话原样回显成一条消息。
 * 真正的 agent 在这里应该把提示词交给你的模型，再把结果打到 stdout。
 *
 * 接入方式（成员驱动）：
 *   { "type": "cli", "cmd": "node", "args": ["examples/echo-agent.js"] }
 *
 * 提示词怎么进来：args 里有 {{prompt}} 就替换进去，没有就走 stdin。
 * 本示例走 stdin，所以能接住任意长度、含空行的提示词。
 */
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 提示词里每条消息的格式是「说话人：正文」，主人固定叫「主人」
  const last = [...lines].reverse().find((l) => l.startsWith('主人：'));
  const said = last ? last.slice('主人：'.length) : '（没听到内容）';

  process.stdout.write(`我听到了：「${said}」——这是 cli 驱动的最小示例回复。\n`);
});
