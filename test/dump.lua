-- Loads a SavedVariables file the way the game does and prints its globals in a canonical
-- form (sorted keys), so two files can be compared by value.
local f = assert(loadfile(arg[1]))
local env = { math = math }
setfenv(f, env)
f()
local function cmp(a, b)
  local ta, tb = type(a), type(b)
  if ta ~= tb then return ta < tb end
  if ta == 'boolean' then return tostring(a) < tostring(b) end
  return a < b
end
local function ser(v)
  local t = type(v)
  if t == 'table' then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, cmp)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = '[' .. ser(k) .. ']=' .. ser(v[k]) end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif t == 'string' then return string.format('%q', v)
  elseif t == 'number' then return string.format('%.17g', v)
  else return tostring(v) end
end
env.math = nil
io.write(ser(env))
