// ⚠️ 这不是 Node 脚本，不要用 node 运行它。
//
// 金山文档 · 普通在线表格(ET) 的 **AirScript 读表脚本**。
// 用法：打开繁中服卡池表 →「效率」/「更多」→ AirScript 脚本编辑器 → 新建脚本 →
//      把下面 main() 的整段粘进去 → 保存 → 「脚本信息」里生成**脚本令牌**（半年有效），
//      并把 URL 里的 file_id / script_id 填进 scripts/lib/airscript.mjs。
//
// ⚠️ 2026-10-02 实测：**webhook 的 body 传不进脚本** —— `Context.sheet_name`、顶层
//    `sheet_name`、`Context.argv.sheet_name`、`Context.args.sheet_name` 全试过，脚本里
//    一律取不到，数据永远是工作簿的**第一张表**（响应里的 sheet 字段可自证）。
//    所以这里**不再按参数选表**，改成**一次返回整本工作簿**，由 Node 侧按表名挑
//    （scripts/lib/airscript.mjs 的 readSheets）。别再改回「按参数选表」。
//
// 返回值进响应的 data.result：
//   { sheets: [ {sheet, rowCount, colCount, data}, … ], debug: {…} }
//   （响应外层是 { data: { logs, result }, error, status }）
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

var SHEET_NAMES = ['繁中轮换记录', '繁中中坚记录', '繁中中坚甄选记录'];

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
  for (var r = 1; r <= rc; r++) {
    var rowArr = [];
    for (var c = 1; c <= cc; c++) {
      rowArr.push(cellText(sheet.Cells(r, c)));
    }
    data.push(rowArr);
  }
  return { sheet: sheet.Name, rowCount: rc, colCount: cc, data: data };
}

/** 按名字取表；取不到就退回按序号取。两种都记进 debug，便于排查。 */
function pickSheet(name, index, debug) {
  var s = null;
  try {
    s = Application.Sheets(name);
    if (s) debug.byName = true;
  } catch (e) { debug.errs.push('byName ' + name + ': ' + ('' + e)); }
  if (!s) {
    try {
      s = Application.Sheets(index);
      if (s) debug.byIndex = true;
    } catch (e) { debug.errs.push('byIndex ' + index + ': ' + ('' + e)); }
  }
  return s;
}

function main() {
  var debug = { sheetsCount: -1, byName: false, byIndex: false, errs: [] };
  try { debug.sheetsCount = Application.Sheets.Count; } catch (e) { debug.errs.push('Count: ' + ('' + e)); }

  var sheets = [];
  for (var i = 0; i < SHEET_NAMES.length; i++) {
    var s = pickSheet(SHEET_NAMES[i], i + 1, debug);
    if (!s) {
      sheets.push({ sheet: SHEET_NAMES[i], error: '找不到这张表' });
      continue;
    }
    try { sheets.push(readSheet(s)); }
    catch (e) { sheets.push({ sheet: SHEET_NAMES[i], error: 'readSheet 失败: ' + ('' + e) }); }
  }
  return { sheets: sheets, debug: debug };
}
return main();
