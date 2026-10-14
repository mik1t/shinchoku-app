// プロトタイプ（sales-note.html）の runAI() / makeMinutes() / vocab() をそのまま移植したもの。

const CASE_ST = [["recv", "紹介受領"], ["screen", "スクリーニング"], ["nda", "NDA・詳細検討"], ["meet", "トップ面談"], ["loi", "意向表明"], ["close", "成約"], ["drop", "見送り"]];
const stList = (st) => st.map(([a, b]) => `${a}=${b}`).join(", ");
const WD = ["日", "月", "火", "水", "木", "金", "土"];

export const MA_TERMS = ["IM", "NDA", "LOI", "トップ面談", "基本合意", "DD", "ノンネーム", "顧問先", "税理士法人"];

const BIZ = `社長は2つの事業を行っています。
(1) M&A仲介会社とのやり取り代行：M&Aを進めたいクライアント企業の代わりに、M&A仲介会社に口座を作り、案件の紹介を受け、スクリーニングし、仲介会社との会食を設定する。
(2) 会計事務所へのおつなぎ：自社サービスを営業したいクライアント企業を税理士法人につなぎ、税理士法人から顧問先へ紹介してもらう。
「クライアント」は社長の顧客企業。M&A仲介会社や税理士法人はクライアントではなく「つなぎ先」。`;

// 日本時間の今日
export function todayJST(now = new Date()) {
  const d = new Date(now.getTime() + 9 * 3600 * 1000);
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, wd: WD[d.getUTCDay()] };
}

function helpers(data) {
  const partners = Object.fromEntries(data.partners.map((p) => [p.id, p]));
  const pName = (l) => (l && partners[l.partnerId]?.name) || l?.partner || "（未設定）";
  const viaName = (x) => (x.viaId && partners[x.viaId]?.name) || x.via || "";
  const personOf = (l) => {
    const p = partners[l.partnerId];
    return p && l.personId ? (p.persons || []).find((x) => x.id === l.personId) : null;
  };
  return { pName, viaName, personOf };
}

export function vocab(data) {
  const names = new Set();
  data.clients.forEach((c) => {
    names.add(c.company);
    if (c.contact) names.add(c.contact);
    (c.cases || []).forEach((x) => names.add(x.name));
  });
  data.partners.forEach((p) => {
    names.add(p.name);
    (p.persons || []).forEach((x) => names.add(x.name));
  });
  const d = (data.settings.dict || []).map((w) => (w.hint ? `${w.word}（${w.hint} と聞こえることがある）` : w.word));
  return `音声認識の誤変換を直すための固有名詞・用語リスト（同音・似た音の語はこの表記に直す）:
${[...names].filter(Boolean).join("、")}
${d.length ? "社長の用語辞書: " + d.join("、") : ""}
M&A用語: IM（企業概要書）、NDA（秘密保持契約）、LOI（意向表明書）、トップ面談、基本合意、DD（デューデリジェンス）、ノンネーム、顧問先、税理士法人`;
}

export function sortPrompt(data, text, focusId) {
  const { pName, viaName, personOf } = helpers(data);
  const { ymd, wd } = todayJST();
  const focus = focusId && data.clients.find((c) => c.id === focusId);
  const existing = data.clients.map((c) => ({
    clientId: c.id, company: c.company, contact: c.contact,
    links: (c.links || []).map((l) => ({ linkId: l.id, kind: l.kind, partner: pName(l), person: personOf(l)?.name || null, status: l.status })),
    cases: (c.cases || []).map((x) => ({ caseId: x.id, name: x.name, via: viaName(x), status: x.status })),
    openTasks: (c.tasks || []).filter((t) => !t.done).map((t) => ({ id: t.id, title: t.title, due: t.due })),
  }));
  return `あなたはM&Aアドバイザリー会社の社長の進捗管理アシスタントです。${BIZ}
社長が話したメモ（または会議の文字起こし）を読み、クライアント別の記録を更新する指示をJSONで返してください。
${vocab(data)}

今日: ${ymd}（${wd}曜日）
M&A仲介会社とのつなぎ(kind=ma)の状態: active=進行中, stop=休止（やり取りをやめた・止めたときだけ stop）
紹介案件(cases)のステータス: ${stList(CASE_ST)}
税理士法人とのつなぎ(kind=tax)の状態: active=進行中, stop=休止
${focus ? `このメモは基本的にクライアント「${focus.company}」(clientId: ${focus.id}) についてのもの。別のクライアント名がはっきり出たときだけ別扱い。\n` : ""}
既存データ:
${JSON.stringify(existing)}

メモ:
"""${text}"""

ルール:
- クライアントごとに1つの update。既存なら clientId（表記ゆれ・誤変換も考慮）。新規なら null。
- links: つなぎ先の変化。既存なら linkId、新規なら null と kind/partner。status は読み取れたときだけ。person は先方担当者名が出たときだけ。
- cases: 仲介会社から紹介された売り案件。案件名は「業種・地域・規模」など短く。via は経由した仲介会社名。既存なら caseId。
- addTasks: 社長がやるべき行動（次の一手もここに入れる）。期限は YYYY-MM-DD（「来週金曜」なども今日から計算）、なければ null。about には関係するつなぎ先の会社名、または案件名をそのまま入れる（特定の相手がなければ null）。既存の未完了タスクと重複させない。
- completeTaskIds: 完了したと読み取れる既存タスクのid。
- links と cases の各要素の note: その相手・案件について今回あったこと（面談した、資料を受領した等）を30字以内。なければ null。
- update の note: 特定の相手に紐づかない、クライアント全般の話だけを40字以内。なければ null。誤変換は文脈で補正。

次の形のJSONだけを返す:
{"updates":[{"clientId":null,"company":"","contact":null,"links":[{"linkId":null,"kind":"ma","partner":"","person":null,"status":null,"note":null}],"cases":[{"caseId":null,"name":"","via":null,"status":null,"note":null}],"addTasks":[{"title":"","due":null,"about":null}],"completeTaskIds":[],"note":""}]}`;
}

export function minutesPrompt(data, text, date) {
  const list = data.clients.map((c) => ({ clientId: c.id, company: c.company }));
  return `あなたはM&Aアドバイザリー会社の社長の秘書です。${BIZ}
次の会議の文字起こしを、社内向けの議事録に整理してください。
${vocab(data)}

既存のクライアント一覧: ${JSON.stringify(list)}
会議日: ${date}

文字起こし:
"""${text}"""

ルール:
- title: 会議の内容がわかる短い会議名（20字以内）。
- clients: この会議で扱われた対象クライアント。一覧にあれば clientId を入れ、なければ null で name のみ。つなぎ先（仲介会社・税理士法人）はクライアントに含めない。
- agenda: 協議事項。話し合ったテーマごとに title（短い見出し）と detail（結論や論点を1〜2文）。
- summary: 会議全体のサマリー。3〜6文、段落を分けるときは改行。
- nextActions: 決まった次の行動。task（何をするか）、owner（誰が。わからなければ空文字）、due（YYYY-MM-DD、会議日から計算、なければ null）、client（関係するクライアント名、なければ null）。
- 話し言葉の言い淀みや誤変換は補正し、ビジネス文書として簡潔な常体（〜する／〜した）で統一する。

次の形のJSONだけを返す:
{"title":"","clients":[{"clientId":null,"name":""}],"agenda":[{"title":"","detail":""}],"summary":"","nextActions":[{"task":"","owner":"","due":null,"client":null}]}`;
}

// Whisper の initial_prompt。上限は 224 トークン（Whisper の仕様）なので、
// 余裕を見て見積もり 200 トークン以内に収める。M&A用語と用語辞書を先に入れ、
// 残りに固有名詞を更新が新しい順に詰める。
export function whisperPrompt(rows, budget = 200) {
  const est = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) < 128 ? 0.35 : 1.5), 0);
  const words = [];
  const seen = new Set();
  let used = est("用語：");
  const push = (w) => {
    w = String(w || "").trim();
    if (!w || seen.has(w)) return true;
    const cost = est(w) + 1.5; // 区切りの「、」
    if (used + cost > budget) return false;
    seen.add(w);
    words.push(w);
    used += cost;
    return true;
  };
  MA_TERMS.forEach(push);
  const dict = (rows.settings.dict || []).slice().reverse(); // 後から追加した語ほど新しい
  for (const d of dict) push(d.word);
  const named = [];
  rows.clients.forEach((c) => {
    const at = c.updatedAt || 0;
    named.push([c.company, at]);
    if (c.contact) named.push([c.contact, at]);
    (c.cases || []).forEach((x) => named.push([x.name, x.updatedAt || at]));
  });
  rows.partners.forEach((p) => {
    const at = p.updatedAt || p.createdAt || 0;
    named.push([p.name, at]);
    (p.persons || []).forEach((x) => named.push([x.name, at]));
  });
  named.sort((a, b) => b[1] - a[1]);
  for (const [w] of named) {
    if (/^(新しいクライアント|新しい案件|新しい担当者|（未設定）)$/.test(String(w))) continue;
    push(w);
  }
  return "用語：" + words.join("、") + "。";
}
