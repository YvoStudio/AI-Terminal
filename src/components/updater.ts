import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const DISMISS_KEY = 'updater:dismissed-version';

export async function checkForUpdates(silent = true): Promise<void> {
  let update: Update | null = null;
  try {
    update = await check();
  } catch (err) {
    if (!silent) {
      alert(`检查更新失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (!update) {
    if (!silent) alert('当前已是最新版本');
    return;
  }

  if (silent && localStorage.getItem(DISMISS_KEY) === update.version) {
    return;
  }

  showUpdateDialog(update);
}

function showUpdateDialog(update: Update): void {
  const overlay = document.createElement('div');
  overlay.className = 'updater-overlay';
  overlay.innerHTML = `
    <div class="updater-dialog">
      <div class="updater-header">
        <h3>发现新版本 v${escapeHtml(update.version)}</h3>
        <div class="updater-current">当前版本 v${escapeHtml(update.currentVersion ?? '')}</div>
      </div>
      <div class="updater-notes">${formatNotes(update.body)}</div>
      <div class="updater-progress hidden">
        <div class="updater-progress-bar"><div class="updater-progress-fill"></div></div>
        <div class="updater-progress-text">准备下载...</div>
      </div>
      <div class="updater-actions">
        <button class="updater-btn-secondary" data-action="skip">跳过此版本</button>
        <button class="updater-btn-secondary" data-action="later">稍后提醒</button>
        <button class="updater-btn-primary" data-action="install">立即更新并重启</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const skipBtn = overlay.querySelector<HTMLButtonElement>('[data-action="skip"]')!;
  const laterBtn = overlay.querySelector<HTMLButtonElement>('[data-action="later"]')!;
  const installBtn = overlay.querySelector<HTMLButtonElement>('[data-action="install"]')!;
  const progressEl = overlay.querySelector<HTMLElement>('.updater-progress')!;
  const fillEl = overlay.querySelector<HTMLElement>('.updater-progress-fill')!;
  const textEl = overlay.querySelector<HTMLElement>('.updater-progress-text')!;

  skipBtn.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, update.version);
    close();
  });
  laterBtn.addEventListener('click', close);

  installBtn.addEventListener('click', async () => {
    skipBtn.disabled = true;
    laterBtn.disabled = true;
    installBtn.disabled = true;
    progressEl.classList.remove('hidden');

    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            textEl.textContent = total > 0 ? `开始下载 ${formatSize(total)}...` : '开始下载...';
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.min(100, (downloaded / total) * 100);
              fillEl.style.width = `${pct}%`;
              textEl.textContent = `下载中 ${formatSize(downloaded)} / ${formatSize(total)} (${pct.toFixed(0)}%)`;
            } else {
              textEl.textContent = `已下载 ${formatSize(downloaded)}`;
            }
            break;
          case 'Finished':
            fillEl.style.width = '100%';
            textEl.textContent = '下载完成，正在安装...';
            break;
        }
      });
      textEl.textContent = '安装完成，即将重启...';
      await relaunch();
    } catch (err) {
      textEl.textContent = `更新失败: ${err instanceof Error ? err.message : String(err)}`;
      skipBtn.disabled = false;
      laterBtn.disabled = false;
      installBtn.disabled = false;
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function formatNotes(body: string | undefined): string {
  if (!body) return '<div class="updater-notes-empty">（无更新说明）</div>';
  return escapeHtml(body).replace(/\n/g, '<br>');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
