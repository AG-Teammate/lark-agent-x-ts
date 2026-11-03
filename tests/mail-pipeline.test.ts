import { describe, expect, test } from 'bun:test';
import { extractMailCmds, extractMailSchemas } from '../scripts/proto-pipeline/mail.js';

/** Constants module: exports first, then the const list that starts with the IM cmd numbers 46, 201. */
const CONSTANTS =
  'function(e,t,n){"use strict";n.d(t,"a",(function(){return r})),n.d(t,"b",(function(){return i})),' +
  'n.d(t,"c",(function(){return a})),n.d(t,"d",(function(){return o}));const r=46,i=201,a=3601,o=3602}';

/** Table module: codecs bound to schema registrations (inline and by variable), then the cmd table. */
const TABLE =
  'function(e,t,n){"use strict";' +
  'var s={fields:{threadBizIds:{rule:"repeated",type:"string",id:1}}},u={fields:{metas:{type:"string",id:1}}};' +
  'var p=(Object(a.a)("mails","GetMailThreadMetaRequest",{fields:{labelId:{type:"string",id:1},note:{type:"string",id:2,options:{default:"}{"}}}}),' +
  'Object(a.a)("mails","Unused",{options:{x:1}})),' +
  'q=Object(a.a)("mails","GetMailThreadMetaResponse",{fields:{hasMore:{type:"bool",id:1}}}),' +
  'v=Object(a.a)("mails","GetThreadMetaByThreadIDsRequest",s),' +
  'w=Object(a.a)("mails","GetThreadMetaByThreadIDsResponse",u),' +
  'x=Object(a.a)("mails","Placeholder",void 0);' +
  'var ft={};' +
  'i()(ft,pt.c,_t("GET_MAIL_THREAD_META",p,q)),' +
  'i()(ft,pt.d,_t("GET_THREAD_META_BY_IDS",v,w)),' +
  'i()(ft,pt.c,_t("UNRESOLVED_CODEC",zz,q)),' +
  'i()(ft,pt.z,_t("UNKNOWN_CMD_LETTER",p,q)),ft);' +
  'function _t(e,t,n){return{cmd:e,request:t,response:n}}';

const BUNDLE = `!function(){var modules=[${CONSTANTS},${TABLE}]}();`;

describe('mail bundle extraction', () => {
  test('extractMailCmds resolves cmd numbers and codec names, skipping unresolved entries', () => {
    expect(extractMailCmds(BUNDLE)).toEqual([
      '3601|mails.GetMailThreadMetaRequest|mails.GetMailThreadMetaResponse',
      '3602|mails.GetThreadMetaByThreadIDsRequest|mails.GetThreadMetaByThreadIDsResponse',
    ]);
  });

  test('extractMailCmds fails loudly when the layout changes', () => {
    expect(() => extractMailCmds(CONSTANTS)).toThrow('cmd table not found');
    expect(() =>
      extractMailCmds(
        `${CONSTANTS},function(e,t,n){"use strict";var a=1;function _t(e,t,n){return{cmd:e,request:t,response:n}}`,
      ),
    ).toThrow('cmd table is empty');
    expect(() => extractMailCmds(TABLE)).toThrow('cmd constants not found');
  });

  test('extractMailSchemas reads inline and variable registrations, skipping non-schemas', () => {
    const schemas = extractMailSchemas(BUNDLE);
    expect([...schemas.keys()].sort()).toEqual([
      'mails.GetMailThreadMetaRequest',
      'mails.GetMailThreadMetaResponse',
      'mails.GetThreadMetaByThreadIDsRequest',
      'mails.GetThreadMetaByThreadIDsResponse',
    ]);
    // Braces inside strings do not end the literal
    expect(schemas.get('mails.GetMailThreadMetaRequest')).toBe(
      '{fields:{labelId:{type:"string",id:1},note:{type:"string",id:2,options:{default:"}{"}}}}',
    );
    expect(schemas.get('mails.GetThreadMetaByThreadIDsRequest')).toBe(
      '{fields:{threadBizIds:{rule:"repeated",type:"string",id:1}}}',
    );
  });

  test('extractMailSchemas keeps the first registration of a name', () => {
    const src =
      'Object(a.a)("mails","Dup",{fields:{first:{type:"string",id:1}}});' +
      'Object(a.a)("mails","Dup",{fields:{second:{type:"string",id:1}}})';
    expect(extractMailSchemas(src).get('mails.Dup')).toBe('{fields:{first:{type:"string",id:1}}}');
  });
});
