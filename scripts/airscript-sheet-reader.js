// ⚠️ 这不是 Node 脚本，不要用 node 运行它。
//
// 金山文档 · 普通在线表格(ET) 的 **AirScript 读表脚本（单表版）**。
// 用法：打开繁中服卡池表 →「效率」/「更多」→ AirScript 脚本编辑器 → 新建/替换脚本 →
//      把下面 main() 的整段粘进去 → 保存 → 生成**脚本令牌**，并把 file_id / script_id
//      填进 scripts/lib/airscript.mjs。
//      Node 侧分三次调用，每次在 body 的 Context.argv.sheet 传 1 / 2 / 3 选表。
//
// ⚠️ 2026-10-03 实测关键结论：
//   - `Context.sheet_name` 会被平台丢弃（永远取不到），但 `Context.argv.<键>` **完整透传**。
//     所以选表只能用 argv.sheet（1/2/3 索引），不要用 sheet_name。
//   - 一次读整本工作簿（3 表）会被平台以顶层 `{"errno":10000,"result":"Unavailable"}` 拒绝
//     （连 logs 都没有，脚本根本没开始执行），故拆成「单表脚本 + Node 分三次调用」。
//
// 返回值进响应的 data.result：
//   { sheet, rowCount, colCount, data }
//   （响应外层是 { data: { logs, result }, error, status }，data 与 result 都是字符串需二次 JSON.parse）
//
// ⚠️ 减重：readSheet 读到「连续 3 行全空」就提前结束，rowCount 是实际读到的行数
//    （不是 UsedRange 的 200）。下游 normalizeGrid 本就会再裁一次尾空行，多读的一两行空行无害。
//
// ---------------------------------------------------------------- 关键坑（都踩过，别凭直觉改）
//  1) 末尾必须显式 `return main();` —— 只定义不执行的话 result 会是 "[Undefined]"。
//  2) 这个引擎里 `Range.Value` 是**方法**不是属性：`used.Value` 拿到的是函数本身，
//     `used.Value.toArray()` 得到的数组元素全是 null。
//  3) **在 Range 上调用 `.Value()` 会让引擎直接崩**（"内部错误"，不可 catch）：
//     `used.Value()` / `Application.Sheets(1).Range("A1").Value()` 都崩。
//  4) 正确取值姿势：**逐格 `sheet.Cells(r, c).Text`** —— 字符串属性，稳定返回显示文本。
//  5) `.Text` 给的是显示文本，日期形如 `2020/6/29`（斜杠、不补零），
//     由 fetcher 的 `cellDate()` 规整成 `2020-06-29`，这里不要自己转。

function cellText(cell) {
  try {
    var t = cell.Text;
    if (t === null || t === undefined) return '';
    return (typeof t === 'string') ? t : ('' + t);
  } catch (e) { return ''; }
}

function readSheet(sheet) {
  var used = sheet.UsedRange;
  var rc = used.Rows.Count, cc = used.Columns.Count;
  var data = [];
  var emptyStreak = 0;
  for (var r = 1; r <= rc; r++) {
    var rowArr = [];
    var rowEmpty = true;
    for (var c = 1; c <= cc; c++) {
      var t = cellText(sheet.Cells(r, c));
      rowArr.push(t);
      if (t !== '') rowEmpty = false;
    }
    /* 减重关键：UsedRange 经常把整张表撑到 200 行，里面大半是带格式的空行。
       逐格 .Text 读一遍 ≈ 4800 次调用，三张表叠起来 14400 次会触发 webhook 超时 / 限流；
       而一次读 3 表被平台直接 Unavailable 拒绝。故拆成单表 + Node 分三次调用。
       真实数据几十行就结束，读到「连续 3 行完全为空」就判定数据区已完、后面的不用再读。
       （中间的孤立空行 ≤2 行不误伤，因为要连续 3 行才停。） */
    if (rowEmpty) {
      emptyStreak++;
      if (emptyStreak >= 3) break;
    } else {
      emptyStreak = 0;
    }
    data.push(rowArr);
  }
  return { sheet: sheet.Name, rowCount: data.length, colCount: cc, data: data };
}

function main() {
  // 选表：用 argv.sheet（1/2/3 索引）。Context.sheet_name 通道被平台丢弃，不可用。
  var idx = 1;
  try {
    if (typeof Context !== 'undefined' && Context && Context.argv && Context.argv.sheet) {
      var n = parseInt(Context.argv.sheet, 10);
      if (!isNaN(n) && n >= 1) idx = n;
    }
  } catch (e) {}
  var sheet = Application.Sheets(idx);
  return readSheet(sheet);
}
return main();
