import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../server/sources/html-to-text';

describe('htmlToText', () => {
  it('drops <style>/<script> bodies, strips tags, decodes entities, collapses whitespace', () => {
    const html = '<style>td {padding-top:37px!important} .view-all-section a {font-size:20px}</style>'
      + '<p>Any update on these guys?&nbsp; Thanks.&nbsp;Regards,&nbsp;Eric &amp; team &lt;x&gt; &#39;ok&#39;</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe("Any update on these guys? Thanks. Regards, Eric & team <x> 'ok'");
  });
});
