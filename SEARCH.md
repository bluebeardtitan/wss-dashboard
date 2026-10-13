# Search guide

There are two ways to find schemes:

- **Text search** — the box in the header. Type plain words; they are matched against card names, field names and field values. Nothing is compiled, so `done & wip` finds that literal text.
- **Filters** — press the **ƒx** button (or **Ctrl/Cmd+K**) to open the *Find schemes* dialog. It opens in the guided **Simple** view by default; power users can flip to **Advanced** to write a raw expression.

The two remember their own query, so switching between them never loses either. When a filter is applied the header shows a pill naming it — click the pill to edit, or its × to remove the filter.

---

## Simple filters (default)

A plain-language builder. Fill in the search box, add one or more filter rows, and watch the live count at the bottom.

### The search box

Looks in **card names, field names and field values**, exactly like the header's text search. Its grammar is the same too: spaces mean **AND**, and `|` means **OR**.

| You type | It means |
| --- | --- |
| `tank` | contains "tank" |
| `pump north` | "pump" AND "north" |
| `pump \| tank` | "pump" OR "tank" |

Leave it blank to filter with rows only, or use it together with rows (the box and the rows are combined with AND).

### Filter rows

Each row is **field → condition → value**:

- **Field** — pick from the fields that exist in your data. *Card name* is offered so you can filter the card's own name like any field.
- **Condition** — `contains`, `is exactly`, `is not`, `starts with`, `is empty`, `is not empty`. Number fields (columns that are mostly numbers) also get `is greater than`, `is less than` and `is between`.
- **Value** — free text; existing values from your data are suggested as you type (via a datalist, so a slightly different value still works).

The two empty checks (`is empty` / `is not empty`) need no value and are the reliable way to find blank or missing fields.

### Match all vs Match any

The toggle above the rows controls how rows combine:

- **Match all** (default) — every row must be true (AND).
- **Match any** — at least one row must be true (OR).

### Case and typing, in plain terms

The builder's text conditions (`contains`, `is exactly`, `is not`, `starts with`) **ignore capitalisation** — `done` matches *Done*, *DONE* and *done*. This is intentionally friendlier than Advanced mode, where `==` is exact. Number conditions compare as real numbers, so `is greater than 400` works whether the stored value is `400` or `"400"`.

### Switching to Advanced

The **Advanced: write an expression** link turns your current filters into the equivalent expression and drops you into the expression editor — a good way to learn the syntax. The **← Back to simple filters** link tries to read the expression back into rows. If the expression uses anything the builder can't represent, nothing is lost: it stays as-is and a note explains why it can't be simplified.

---

## Advanced expressions

Every query in Advanced mode is compiled as a [filtrex](https://github.com/joewalnes/filtrex) expression and tested against every visible card. Only cards where it evaluates to exactly `true` are shown. Advanced is also where legacy/hand-written filters live, so it behaves exactly as it always has.

### Referring to fields

| Form | Example |
| --- | --- |
| Exact reference | `field:"Demand(MLD)" > 400` |
| Single quotes | `field:'Status' == "Completed"` |
| Bare word | `Status == "Completed"` |

- `field:"..."` is the reliable form. It handles spaces, brackets, and punctuation: `field:"No. of Villages" < 2`
- Names match case-insensitively: `field:"district"` finds "District".
- Tags work like any field. They are stored as `#Name` but you can write them either way: `field:"Priority" == "High"` and `field:"#Priority" == "High"` both find the tag named Priority. Bare words resolve too (`priority == "High"`), and `empty(field:"Priority")` correctly reports a card lacking that tag.
- Bare words resolve against field names the same way, but only when they have no spaces or special characters.
- `name` is the card's own name: `name ~= "^Kerala"`.

### Operators

| Operator | Meaning |
| --- | --- |
| `==` `!=` | Equal / not equal (strict: `"Done"` ≠ `"done"`, `400` ≠ `"400"`) |
| `>` `>=` `<` `<=` | Numeric comparison — both sides must be numbers |
| `~=` | Regular expression test: `value ~= "pattern"` |
| `and` `or` `not` | Boolean logic |
| `( )` | Grouping |
| `+` `-` `*` `/` `^` `mod` | Arithmetic |
| `if x then y else z` | Conditional value |
| `(a, b, c)` | Array literal |
| `x in (a, b)` | Membership (`not in` negates) |

### Functions

`abs` `ceil` `floor` `log` `log2` `log10` `max` `min` `round` `sqrt`

The generated Simple filters also use case-insensitive helpers — `icontains`, `istartsWith`, `iequals`, `inotequals` — which you can reuse by hand if you want the builder's "ignore capitals" behaviour inside a written expression:

```
iequals(field:"Status", "done")
```

Two built-ins exist specifically for data checking:

- `exists(field:"Notes")` — true when the field is present and not null.
- `empty(field:"Notes")` — true when missing, blank, or an empty array. Combine with `not`: `not empty(field:"Phone")`.

### Testing "blank" fields and negating comparisons

Use `empty()` to find cards where a field is absent or blank — `== ""` alone cannot see missing fields, because they read as undefined rather than an empty string:

```
empty(field:"RPWSS ID") and not (field:"Scheme Dropped" == "TRUE")
```

Parenthesize negated comparisons. `not x == y` parses as `(not x) == y` — a logical value compared against text — which matches nothing. Write `not (x == y)` instead.

Equality is exact, including capitalization: `"True"` ≠ `"TRUE"`. To ignore case, test characters explicitly:

```
not (field:"Scheme Dropped" ~= "^[Tt][Rr][Uu][Ee]$")
```

### Values and types

- Values that look like numbers are treated as numbers when read from fields: a stored `"400"` equals the literal `400`, and works with `>`, `>=`, and other ordering comparisons.
- Everything else is a string. Equality is strict, so `Status == "Completed"` only matches that exact capitalization.
- A comparison against a missing or blank field is false, not an error. Use `exists()` or `empty()` when you need to distinguish those cases.
- Ordering comparisons (`>` `<` and friends) reject text: `Status > "A"` matches nothing because "Completed" is not a number. Use `==`, `in`, or `~=` for text.

### Examples

```
field:"Demand(MLD)" > 400 and field:"No. of Villages" < 2
Status == "Completed" or Status == "Commissioned"
field:"District" in ("North", "South")
not empty(field:"Notes")
name ~= "^WSS"
field:"Cost" / field:"Villages" > 50
if field:"Status" == "Done" then field:"Cost" < 500 else false
max(field:"Phase 1", field:"Phase 2") >= 3
```

### Matching a list of values

To find cards where a field equals any of several values, use `in` with unquoted numeric literals (stored values that look like numbers are read as numbers):

```
field:"Scheme Code" in (11045, 20145, 45065)
```

If the codes may appear inside longer text (`PH-11045`) or mix types, test them as substrings instead:

```
field:"Scheme Code" ~= "11045|20145|45065"
```

Quoted literals fail with `in` for numeric fields: `in ("11045", ...)` compares text against the number 11045 and never matches.

### When a query is invalid

An expression that fails to compile cannot be applied — the editor's status line explains and the Apply button stays disabled. An invalid filter already active (for example after data changes) marks the search bar red and appends "— invalid expression" to the results line; nothing matches until it is fixed or removed. Runtime problems (for example a regex that never finishes) simply exclude that card instead of breaking the list.

---

## Plain text search (header)

Case-insensitive substring match against card names, field names, and field values. A small **Any / Word / Exact** control in the search bar picks how each term is matched:

- **Any** — the term occurs as a substring anywhere (`district` can hit the middle of a word or value).
- **Word** — the term must stand on its own as a whole word, so `bore` matches `Bore Well` but not `Borewell` or `boring`. Word bounds span letters and digits in any script.
- **Exact** — the term must equal the entire field value or card name on its own (`bore` matches a card exactly named *bore*, nothing else).

Every term in the grammar below is tested under the selected mode.

**Multiple terms:** spaces mean AND, `|` means OR — AND binds tighter:

| Query | Meaning |
| --- | --- |
| `pump` | contains "pump" |
| `pump north` | "pump" AND "north" |
| `pump \| tank` | "pump" OR "tank" |
| `pump north \| intake` | ("pump" AND "north") OR "intake" |

Terms match anywhere — a term like `district` can hit a field's name rather than its value. Stray separators are ignored (`pump \|` equals `pump`), and an empty query shows everything.

### Where search applies

The active filter drives the card list, Select All while in selection mode, and the table generated from the Table modal — all three operate on the same matching set.
