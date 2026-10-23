export const APPEARANCE_VERSION = 1;
export const MAX_WALLPAPER_DATA_LENGTH = 2400000;

export const THEMES = Object.freeze([
  { id: 'meadow', label: '春日草地', description: '保留当前的清爽绿色', metaColor: '#f5f7f2' },
  { id: 'mist', label: '雾蓝日记', description: '安静的蓝灰色调', metaColor: '#eef4f7' },
  { id: 'blossom', label: '樱花便签', description: '温柔的珊瑚与莓红', metaColor: '#fff5f2' },
  { id: 'midnight', label: '深夜留灯', description: '低亮度的深色界面', metaColor: '#121922' },
  { id: 'peach', label: '桃红心情', description: '明亮的桃红粉色', metaColor: '#fff0f4' },
  { id: 'rainbow', label: '彩虹夜幕', description: '黑底与彩色小亮点', metaColor: '#0d0f15' },
]);

const THEME_IDS = new Set(THEMES.map(theme => theme.id));
const IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export const createDefaultAppearance = () => ({ version: APPEARANCE_VERSION, theme: 'meadow', wallpaper: null });

export function cloneAppearance(value) {
  validateAppearance(value);
  return { version: APPEARANCE_VERSION, theme: value.theme, wallpaper: value.wallpaper ? { ...value.wallpaper } : null };
}

export function validateAppearance(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), '外观配置无法读取');
  requireValue(value.version === APPEARANCE_VERSION && THEME_IDS.has(value.theme), '外观配置版本或主题无效');
  requireValue(value.wallpaper === null || (value.wallpaper && typeof value.wallpaper === 'object'), '壁纸配置无法读取');
  if (value.wallpaper) {
    requireValue(typeof value.wallpaper.dataUrl === 'string' && IMAGE_DATA_URL.test(value.wallpaper.dataUrl), '壁纸格式无法读取');
    requireValue(value.wallpaper.dataUrl.length <= MAX_WALLPAPER_DATA_LENGTH, '壁纸文件过大');
    requireValue(typeof value.wallpaper.name === 'string' && value.wallpaper.name.length <= 200, '壁纸名称无法读取');
  }
  return value;
}

export function createAppearanceStore(storage, pathname, search) {
  const key = `life-save:appearance-v1:${JSON.stringify([pathname, search])}`;
  let raw = storage.getItem(key);
  let appearance = raw === null ? createDefaultAppearance() : cloneAppearance(validateAppearance(JSON.parse(raw)));
  return {
    key,
    get appearance() { return appearance; },
    commit(next) {
      if (storage.getItem(key) !== raw) throw new Error('另一个页面更新了外观，请刷新后重试。');
      const normalized = cloneAppearance(next);
      const serialized = JSON.stringify(normalized);
      storage.setItem(key, serialized);
      appearance = normalized;
      raw = serialized;
      return appearance;
    },
    reload() {
      const nextRaw = storage.getItem(key);
      if (nextRaw === null) {
        appearance = createDefaultAppearance();
        raw = null;
        return appearance;
      }
      appearance = cloneAppearance(validateAppearance(JSON.parse(nextRaw)));
      raw = nextRaw;
      return appearance;
    },
  };
}
