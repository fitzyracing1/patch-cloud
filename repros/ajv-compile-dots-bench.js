// Old vs PR #2591 implementations of compile-dots helpers, timed on adversarial "code"
var ERROR_KEYWORD = /\$errorKeyword/g;
var ERROR_KEYWORD_OR = /\$errorKeyword\s+\|\|/g;
var ERROR_KEYWORD_STR_PR = ERROR_KEYWORD.source.replace(/^\\\\/, '');
function oldImpl(code, v) {
  function occ(r){ return (code.match(r)||[]).length; }
  v = v.replace(/\$/g, '\\$$');
  var count = occ(new RegExp(v + '[^A-Za-z0-9_$]', 'g'));
  if (count == 1) code = code.replace(new RegExp('var\\s+' + v + '\\s*=[^;]+;|var\\s+' + v + ';'), '');
  var cu = occ(ERROR_KEYWORD), co = occ(ERROR_KEYWORD_OR);
  if (cu == co + 1) code = code.replace(ERROR_KEYWORD_OR, '');
  return code;
}
function prImpl(code, v) {
  var count = 0, idx = 0;
  while ((idx = code.indexOf(v, idx)) !== -1) { if (idx + v.length >= code.length || !/[A-Za-z0-9_$]/.test(code[idx + v.length])) count++; idx += 1; }
  if (count == 1) { var vEsc = v.replace(/\$/g, '\\$$'); code = code.replace(new RegExp('var\\s+' + vEsc + '\\s*=[^;]*?;|var\\s+' + vEsc + ';'), ''); }
  var cu = code.split(ERROR_KEYWORD_STR_PR).length - 1; var co = 0; idx = 0;
  while ((idx = code.indexOf(ERROR_KEYWORD_STR_PR + ' ||', idx)) !== -1) { co++; idx += 1; }
  if (cu == co + 1) code = code.replace(ERROR_KEYWORD_OR, '');
  return code;
}
console.log('ERROR_KEYWORD_STR_PR =', JSON.stringify(ERROR_KEYWORD_STR_PR));
var inputs = {
  'many "$errorKeyword" + spaces, no ||': ('$errorKeyword' + ' '.repeat(2000)).repeat(20),
  'single var $errs = ... no ;': 'var $errs = ' + 'a'.repeat(200000) + ' $errs ',
  'repeated "var $errs =" no ;': 'var $errs = a'.repeat(20000),
  'whitespace bomb "\\s+"': '$errorKeyword' + ' '.repeat(100000) + 'x',
};
for (var k in inputs) {
  var c = inputs[k];
  var t0 = process.hrtime.bigint(); oldImpl(c, '$errs'); var t1 = process.hrtime.bigint(); prImpl(c, '$errs'); var t2 = process.hrtime.bigint();
  console.log(k.padEnd(40), 'old', (Number(t1-t0)/1e6).toFixed(1)+'ms', ' pr', (Number(t2-t1)/1e6).toFixed(1)+'ms');
}
