"""Generate parity fixtures with the original (fork) Python implementation: tests/fixtures/parity.json.

All data is synthetic; no real messages. The TS tests compare decoded summaries, storage format, push parsing,
send-packet bytes and response decoding item by item.
Usage (in a Python environment with larkx installed):
    python scripts/gen-parity-fixtures.py <path to LarkAgentX repo>
"""
import base64
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]).expanduser().resolve()
sys.path.insert(0, str(repo))

from larkx.proto import builders, decoders  # noqa: E402
from larkx.proto import lark_all_pb2 as L  # noqa: E402
from larkx.proto import proto_pb2 as P  # noqa: E402
from larkx.storage import _json_default  # noqa: E402

b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
dumps = lambda d: json.dumps(d, ensure_ascii=False, default=_json_default)  # noqa: E731


def rich(rt, parts):
    for i, (tag, prop) in enumerate(parts, 1):
        el = rt.elements.dictionary[str(i)]
        el.tag = tag
        el.property = prop.SerializeToString()
        rt.elementIds.append(str(i))


def text_prop(s):
    tp = P.TextProperty()
    tp.content = s
    return tp


def at_prop(uid, name):
    ap = P.AtProperty()
    ap.userId = uid
    ap.content = name
    return ap


contents = []


def case(name, msg_type, msg):
    contents.append({'name': name, 'type': msg_type, 'bytes': b64(msg.SerializeToString())})


tc = P.TextContent()
rich(tc.richText, [(1, text_prop('月报导出能加个按部门筛选吗')), (5, at_prop('7100000000000000002', '@同事乙')), (1, text_prop(' 谢谢'))])
tc.richText.innerText = '月报导出能加个按部门筛选吗@同事乙 谢谢'
case('文本+@', 4, tc)
tc2 = P.TextContent()
tc2.text = '纯文本'
case('纯文本', 4, tc2)
tc3 = P.TextContent()
rich(tc3.richText, [(3, text_prop('第一段')), (2, text_prop('x')), (10, text_prop('y')), (5, P.AtProperty())])
case('段落+占位', 4, tc3)
pc = P.PostContent()
pc.title = '周报'
rich(pc.richText, [(3, text_prop('本周完成月报导出')), (1, text_prop('下周计划'))])
case('富文本', 2, pc)
ic = P.ImageContent()
ic.image.origin.key = 'img_v3_origin'
ic.image.origin.width = 640
ic.image.origin.height = 480
case('图片', 5, ic)
fc = P.FileContent()
fc.name = '月报.xlsx'
fc.mime = 'application/vnd.ms-excel'
fc.size = 12345
fc.key = 'file_v3_x'
case('文件', 3, fc)
mc = P.MediaContent()
mc.name = '演示.mp4'
mc.duration = 12345
mc.size = 9876543210
mc.key = 'file_v3_media'
case('视频', 15, mc)
ac = P.AudioContent()
ac.duration = 3500
ac.key = 'file_v3_audio'
case('语音', 7, ac)
sc = P.StickerContent()
sc.stickerId = 'stk_1'
sc.key = 'img_v3_stk'
case('表情包', 10, sc)
cc = P.CardContent()
cc.jsonCard = '{"title":"审批"}' * 200
case('卡片', 14, cc)
mfc = P.MergeForwardContent()
mfc.groupChatName = '项目协作群'
for i in range(2):
    m = mfc.messages.add()
    m.type = 4
    m.fromId = f'710000000000000000{i}'
    t = P.TextContent()
    t.text = f'第{i}条'
    m.content = t.SerializeToString()
case('合并转发', 11, mfc)
lc = P.LocationContent()
lc.latitude = '31.2304'
lc.longitude = '121.4737'
lc.locationDescription.name = '会议室'
lc.locationDescription.description = '三楼'
case('位置', 20, lc)
syc = P.SystemContent()
syc.typeNum = 7
item = syc.sysContentValues['a'].items.add()
item.text = '同事甲'
item2 = syc.sysContentValues['b'].items.add()
item2.text = '加入了群聊'
case('系统消息', 6, syc)
suc = P.ShareUserCardContent()
suc.name = '同事乙'
suc.userId = '7100000000000000002'
case('名片', 23, suc)
sgc = P.ShareGroupChatContent()
sgc.chat.name = '项目协作群'
sgc.chat.id = '7200000000000000001'
case('群分享', 9, sgc)
hc = P.HongbaoContent()
hc.subject = '恭喜发财'
case('红包', 17, hc)
ec = P.EmailContent()
ec.title = '周会纪要'
ec.text = '见附件'
case('邮件', 8, ec)
contents.append({'name': '未知类型', 'type': 24, 'bytes': ''})
contents.append({'name': '解析失败', 'type': 4, 'bytes': b64(b'\xff\xff\xff')})

for c in contents:
    summary, data = decoders.decode_message_content(c['type'], base64.b64decode(c['bytes']))
    c['summary'] = summary
    c['content_data'] = dumps(data) if data is not None else None

# Push frames
pmr = P.PushMessagesRequest()
m1 = pmr.messages['7000000000000000001']
m1.id = '7000000000000000001'
m1.type = 4
m1.fromId = '7100000000000000001'
m1.chatId = '7200000000000000001'
m1.chatType = 2
m1.position = 41
m1.createTime = 1790000000
m1.content = tc.SerializeToString()
m2 = pmr.messages['7000000000000000002']
m2.id = '7000000000000000002'
m2.type = 4
m2.fromId = '7100000000000000001'
m2.chatId = '7200000000000000001'
m2.chatType = 2
m2.rootId = '7000000000000000001'
m2.threadId = '7000000000000000001'
m2.threadPosition = 0
m2.content = tc2.SerializeToString()
pmr.messagesAtMe['7000000000000000001'] = True
pkt = P.Packet()
pkt.cmd = 6
pkt.sid = 'sid-1'
pkt.payload = pmr.SerializeToString()
frame = P.Frame()
frame.seqid = 1
frame.payload = pkt.SerializeToString()
raw = frame.SerializeToString()
push = []
for msg in decoders.decode_push_messages(raw):
    msg = dict(msg)
    msg['content_data'] = dumps(msg['content_data']) if msg['content_data'] is not None else None
    push.append(msg)


def normalized(pkt_obj, typ):
    """Clear the randomly generated cid / searchSession before comparing bytes."""
    req = typ()
    req.ParseFromString(pkt_obj.payload)
    if hasattr(req, 'cid'):
        req.ClearField('cid')
    if typ is P.UniversalSearchRequest:
        req.header.ClearField('searchSession')
    pkt_obj.payload = req.SerializeToString()
    pkt_obj.ClearField('cid')
    return b64(pkt_obj.SerializeToString())


spec = {'blocks': [
    {'type': 'p', 'runs': [{'text': '#0034 ', 'bold': True}, {'text': '回复建议'}]},
    {'type': 'ul', 'items': [[{'text': '要点一'}], [{'link': {'text': '原文', 'href': 'https://example.com/a'}}]]},
    {'type': 'quote', 'blocks': [{'type': 'p', 'runs': [{'at': {'user_id': '7100000000000000002', 'text': '@同事乙'}}]}]},
    {'type': 'blank'},
    {'type': 'p', 'runs': [{'link': {'href': 'https://example.com/b'}}]},
]}
send = [
    {'name': '文本', 'text': '收到', 'chat': 'c1', 'root': None, 'reply': None, 'thread_chat': False, 'links': False},
    {'name': '链接', 'text': '见[月报](https://example.com/r) 和 [x](http://y)', 'chat': 'c1', 'root': None, 'reply': None, 'thread_chat': False, 'links': True},
    {'name': '话题回复', 'text': '好的', 'chat': 'c1', 'root': 'r1', 'reply': None, 'thread_chat': False, 'links': False},
    {'name': '话题群回复', 'text': '好的', 'chat': 'c1', 'root': 'r1', 'reply': None, 'thread_chat': True, 'links': False},
    {'name': '引用', 'text': '好的', 'chat': 'c1', 'root': None, 'reply': 'm1', 'thread_chat': False, 'links': False},
    {'name': '话题内引用', 'text': '好的', 'chat': 'c1', 'root': 'r1', 'reply': 'm1', 'thread_chat': False, 'links': False},
]
for s in send:
    p = builders.build_send_message_packet(s['text'], s['chat'], 'req', root_id=s['root'], thread_chat=s['thread_chat'], reply_to=s['reply'], rich_links=s['links'])
    s['packet'] = normalized(p, P.PutMessageRequest)
rich_pkt = normalized(builders.build_rich_message_packet(spec, '摘要', 'c1', 'req', reply_to='m1'), P.PutMessageRequest)
post_pkt = normalized(builders.build_post_message_packet('<p>hi</p>', 'c1', 'req', title='标题', root_id='r1'), P.PutMessageRequest)
others = {
    'create_chat': normalized(builders.build_create_chat_packet('7100000000000000002', 'req'), P.PutChatRequest),
    'search': normalized(builders.build_search_packet('同事', 'req', 'en_US'), P.UniversalSearchRequest),
    'user_info': normalized(builders.build_user_info_packet('7100000000000000002', '7200000000000000001', 'req'), P.GetUserInfoRequest),
    'group_info': normalized(builders.build_group_info_packet('7200000000000000001', 'req'), P.GetGroupInfoRequest),
}


def resp(payload_msg):
    r = P.Packet()
    r.payload = payload_msg.SerializeToString()
    return r.SerializeToString()


pmresp = P.PutMessageResponse()
pmresp.message.id = '7000000000000000009'
pcresp = P.PutChatResponse()
pcresp.chat.id = '7200000000000000009'
sresp = P.UniversalSearchResponse()
for t, i, title in ((1, 'u1', '同事乙'), (3, 'g1', '项目协作群'), (2, 'x', '忽略')):
    r = sresp.results.add()
    r.type = t
    r.id = i
    r.titleHighlighted = title
ui = P.UserInfo()
loc = ui.userInfoDetail.detail.locales.add()
loc.key_string = 'en_us'
loc.translation = 'Colleague B'
ui.userInfoDetail.detail.nickname = '同事乙'.encode()
gi = P.UserInfo()
gi.userInfoDetail.detail.nickname4 = '项目协作群'.encode()
responses = {
    'put_message': {'bytes': b64(resp(pmresp)), 'expect': builders.decode_put_message_response(resp(pmresp))},
    'put_chat': {'bytes': b64(resp(pcresp)), 'expect': builders.decode_put_chat_response(resp(pcresp))},
    'search': {'bytes': b64(resp(sresp)), 'expect': builders.decode_search_response(resp(sresp))},
    'user_info_en': {'bytes': b64(resp(ui)), 'expect': builders.decode_user_info_response(resp(ui), 'en_US')},
    'user_info_zh': {'bytes': b64(resp(ui)), 'expect': builders.decode_user_info_response(resp(ui), 'zh_CN')},
    'group_info': {'bytes': b64(resp(gi)), 'expect': builders.decode_group_info_response(resp(gi))},
}

out = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'parity.json'
out.write_text(json.dumps({
    'contents': contents,
    'push': {'frame': b64(raw), 'messages': push},
    'send': send,
    'rich': {'spec': spec, 'packet': rich_pkt},
    'post': post_pkt,
    'others': others,
    'responses': responses,
}, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'wrote {out}: {len(contents)} contents, {len(push)} push, {len(send)} send')
