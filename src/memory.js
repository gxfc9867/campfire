import fs from 'node:fs';
import path from 'node:path';
import { HANDLE_RE } from './constants.js';
import { badRequest } from './errors.js';
import { logger } from './logger.js';

const log = logger.child('memory');

/**
 * 成员记忆摘要（data/memory/<handle>.json）。
 *
 * 为什么和 members.json 分开存：
 * 1. 成员每回一次重要消息都可能更新记忆，若写在一起，每次都会触发配置热加载与全量重读；
 * 2. 用户在界面改人设、成员在运行时写记忆，两个写者共用一个文件必然互相覆盖。
 *
 * 内容约定：一段纯文本、面向「未来的自己」，约 500 字以内。
 */
export class Memory {
  constructor({ dir, maxLength = 4000 }) {
    this.dir = dir;
    this.maxLength = maxLength;
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(handle) {
    // handle 已经过 HANDLE_RE 校验，这里再挡一次，防止路径穿越
    if (!HANDLE_RE.test(handle)) throw badRequest('handle 不合法');
    return path.join(this.dir, `${handle}.json`);
  }

  read(handle) {
    try {
      const raw = fs.readFileSync(this.#file(handle), 'utf8');
      const parsed = JSON.parse(raw);
      return {
        digest: String(parsed.digest || ''),
        updatedAt: Number(parsed.updatedAt) || null,
        version: Number(parsed.version) || 0,
      };
    } catch {
      // 没有记忆文件是正常状态，不是错误
      return { digest: '', updatedAt: null, version: 0 };
    }
  }

  /**
   * 覆盖写入。
   * 刻意不做追加——记忆是「摘要」，追加会让它无限膨胀，最终撑爆提示词预算。
   * 需要保留更多信息时，由成员自己压缩成更短的一段再写入。
   */
  write(handle, digest) {
    const text = String(digest ?? '');
    if (text.length > this.maxLength) {
      throw badRequest(`记忆摘要过长（${text.length} 字符，上限 ${this.maxLength}）`);
    }
    const prev = this.read(handle);
    const payload = {
      digest: text,
      updatedAt: Date.now(),
      version: prev.version + 1,
    };
    const file = this.#file(handle);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    log.debug(`记忆已更新 ${handle} (${text.length} 字符)`);
    return payload;
  }

  /** 只取元信息，供成员卡片显示「记忆 · 3 天前更新」而不必传全文。 */
  meta(handle) {
    const { digest, updatedAt, version } = this.read(handle);
    return { chars: digest.length, updatedAt, version };
  }

  /** 成员删除时的清理（物理删除记忆是有意的：归档成员不该继续占位）。 */
  remove(handle) {
    try {
      fs.unlinkSync(this.#file(handle));
    } catch {
      // 不存在就算了
    }
  }
}
