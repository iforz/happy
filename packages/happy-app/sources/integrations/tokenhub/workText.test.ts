import {describe,it,expect,vi} from 'vitest';
vi.mock('@/text',()=>({getCurrentLanguage:()=> 'zh-Hans'}));
import {workTextFor} from './workText';
import {resolveLanguageTag} from '@/text/_all';
describe('Work language',()=>{
 it.each(['zh-Hans','zh-CN','zh_CN','zh'])('resolves %s as Chinese',x=>expect(resolveLanguageTag(x)).toBe('zh-Hans'));
 it.each(['zh-Hant','zh-TW','zh-HK'])('preserves traditional %s',x=>expect(resolveLanguageTag(x)).toBe('zh-Hant'));
 it('localizes actions and errors',()=>{expect(workTextFor('en','send')).toBe('Send');expect(workTextFor('zh-Hans','send')).toBe('发送');expect(workTextFor('en','catalogError')).not.toMatch(/[\u4e00-\u9fff]/);expect(workTextFor('zh-Hans','catalogError')).toContain('禁止发送')});
});
it('describes platform language preferences as local rather than synchronized', () => {
 expect(workTextFor('en', 'localPreferenceDescription')).toBe('Language preferences are saved only on this device.');
 expect(workTextFor('zh-Hans', 'localPreferenceDescription')).toBe('语言偏好仅保存在当前设备。');
});
