-- Initialize one existing terminal over one Rex connection.
local function call(method, args)
    return assert(rex.block.call("com.superlogical.terminal", method, args))
end

-- Preserve the existing grace period for shell startup files. A foreground
-- process or a quiet screen alone does not prove its line editor is ready.
local initial = call("format", {format="text", trim=true}).content
for attempt=1,8 do
    rex.sleep(0.1)
    local current = call("format", {format="text", trim=true}).content
    if current == initial and attempt >= 3 then break end
    initial = current
end

local process = call("process", {})
assert(process.last_exit == nil, "shell exited during startup")
local shell = process.foreground and process.foreground.name:gsub("^-", "")
local setup = rex.args.setups[shell]
local app
if setup then
    local data = " " .. setup .. "\r"
    if shell ~= "bash" then data = "\27[200~ " .. setup .. "\27[201~\r" end
    local written = call("write", {data=data})
    assert(written.bytes_written == #data, "Rex wrote fewer bytes than requested")

    -- Acknowledge the hook itself; no extra delay once it has reported ready.
    for attempt=1,500 do
        local status = call("program_status", {})
        for _, record in ipairs(status.records) do
            if record.id == rex.args.completion_id then app = record.app; break end
        end
        if app then break end
        rex.sleep(0.01)
    end
    assert(app, "Shell completion hook did not initialize")
    -- Keep bootstrap commands out of the captured transcript.
    call("clear", {})
end

return {
    shell=shell,
    app=app,
    initial=call("format", {format="text", trim=true}).content,
    vt=call("format", {format="vt", extra_cursor=true}).content,
}
