import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { validateWorkspaceTarget, type PathBoundaryErrorCode } from './pathBoundary.js';

export type WorkspaceFsErrorCode = PathBoundaryErrorCode
  | 'WORKSPACE_FILE_CHANGED'
  | 'WORKSPACE_FILE_EXISTS'
  | 'WORKSPACE_FILE_NOT_FOUND'
  | 'WORKSPACE_FILE_OPERATION_FAILED'
  | 'WORKSPACE_HANDLE_VERIFICATION_UNAVAILABLE';

export class WorkspaceFsError extends Error {
  constructor(public readonly code: WorkspaceFsErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceFsError';
  }
}

export interface WorkspaceOperationOptions {
  /** Deterministic race injection for tests. Production callers must not set this. */
  afterPreflight?: () => void | Promise<void>;
}

export interface WorkspaceWriteOptions extends WorkspaceOperationOptions {
  expectedSha256?: string;
  mustNotExist?: boolean;
}

export interface WorkspaceMoveOptions extends WorkspaceOperationOptions {
  expectedSha256?: string;
  mustNotExist?: boolean;
}

export const workspaceSha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const POWERSHELL_BROKER = String.raw`
+$ErrorActionPreference='Stop'
+Add-Type -TypeDefinition @'
+using System;
+using System.Collections.Generic;
+using System.ComponentModel;
+using System.IO;
+using System.Runtime.InteropServices;
+using System.Security.Cryptography;
+using Microsoft.Win32.SafeHandles;
+
+public sealed class WxResult { public string data; public int bytes; public string sha256; public string path; }
+public sealed class WxFailure : Exception { public string Code; public WxFailure(string code,string message):base(message){Code=code;} }
+
+public static class WxWorkspaceFs {
+  const uint READ=0x80000000, WRITE=0x40000000, DELETE=0x00010000, READ_ATTR=0x80;
+  const uint SHARE_READ=1, SHARE_WRITE=2, SHARE_DELETE=4, CREATE_NEW=1, OPEN_EXISTING=3;
+  const uint OPEN_REPARSE=0x00200000, BACKUP=0x02000000, WRITE_THROUGH=0x80000000;
+  const uint ATTR_REPARSE=0x400, ATTR_DIRECTORY=0x10;
+  const int FileRenameInfo=3, FileDispositionInfo=4, FileRenameInfoEx=22;
+  const uint RENAME_REPLACE=1, RENAME_POSIX=2;
+
+  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
+    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
+    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime, LastWriteTime;
+    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
+  }
+  [StructLayout(LayoutKind.Sequential)] struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
+  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string n,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
+  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out BY_HANDLE_FILE_INFORMATION i);
+  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,System.Text.StringBuilder p,uint n,uint f);
+  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int c,IntPtr p,uint n);
+
+  static WxFailure Fail(string code,string message){ return new WxFailure(code,message); }
+  static string Full(string p){ return Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar); }
+  static bool Eq(string a,string b){ return String.Equals(Full(a),Full(b),StringComparison.OrdinalIgnoreCase); }
+  static bool Under(string root,string p){ string r=Full(root), q=Full(p); return q.StartsWith(r+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase); }
+  static string Final(SafeFileHandle h){
+    var b=new System.Text.StringBuilder(32768); uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);
+    if(n==0 || n>=b.Capacity) throw Fail("WORKSPACE_FILE_OPERATION_FAILED","GetFinalPathNameByHandleW failed: "+Marshal.GetLastWin32Error());
+    string p=b.ToString(); if(p.StartsWith(@"\\?\UNC\")) p=@"\\"+p.Substring(8); else if(p.StartsWith(@"\\?\")) p=p.Substring(4); return Full(p);
+  }
+  static BY_HANDLE_FILE_INFORMATION Info(SafeFileHandle h){ BY_HANDLE_FILE_INFORMATION i; if(!GetFileInformationByHandle(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error()); return i; }
+  static bool SameIdentity(SafeFileHandle a,SafeFileHandle b){ var x=Info(a); var y=Info(b); return x.VolumeSerialNumber==y.VolumeSerialNumber && x.FileIndexHigh==y.FileIndexHigh && x.FileIndexLow==y.FileIndexLow; }
+  static SafeFileHandle OpenRaw(string p,uint access,uint share,uint disposition,uint flags){
+    var h=CreateFileW(p,access,share,IntPtr.Zero,disposition,flags,IntPtr.Zero);
+    if(h.IsInvalid){ int e=Marshal.GetLastWin32Error(); h.Dispose(); if(e==2 || e==3) throw Fail("WORKSPACE_FILE_NOT_FOUND",p); if(e==80 || e==183) throw Fail("WORKSPACE_FILE_EXISTS",p); throw new Win32Exception(e,p); }
+    return h;
+  }
+  static void Validate(SafeFileHandle h,string expected,string rootFinal,bool directory){
+    var i=Info(h); if((i.FileAttributes&ATTR_REPARSE)!=0) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","reparse point: "+expected);
+    if(directory != ((i.FileAttributes&ATTR_DIRECTORY)!=0)) throw Fail("WORKSPACE_FILE_OPERATION_FAILED","resource type mismatch: "+expected);
+    string f=Final(h); if(!Eq(f,expected) || (!Eq(f,rootFinal) && !Under(rootFinal,f))) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","final handle path mismatch: "+f);
+  }
+  static List<SafeFileHandle> LockParents(string root,string target,bool create,out string rootFinal,out SafeFileHandle parent){
+    string r=Full(root), t=Full(target); if(Eq(r,t)||!Under(r,t)) throw Fail("BUILD_PATH_OUTSIDE_WORKSPACE",t);
+    var held=new List<SafeFileHandle>(); parent=null; rootFinal=null;
+    try {
+      var rh=OpenRaw(r,READ_ATTR,SHARE_READ|SHARE_WRITE,OPEN_EXISTING,OPEN_REPARSE|BACKUP); held.Add(rh);
+      if((Info(rh).FileAttributes&ATTR_REPARSE)!=0) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","workspace root is a reparse point");
+      rootFinal=Final(rh); string rel=t.Substring(r.Length).TrimStart(Path.DirectorySeparatorChar); string[] parts=rel.Split(Path.DirectorySeparatorChar);
+      string current=r, expected=rootFinal;
+      for(int i=0;i<parts.Length-1;i++){
+        current=Path.Combine(current,parts[i]); expected=Path.Combine(expected,parts[i]);
+        if(!Directory.Exists(current)){ if(!create) throw Fail("WORKSPACE_FILE_NOT_FOUND",current); Directory.CreateDirectory(current); }
+        var dh=OpenRaw(current,READ_ATTR,SHARE_READ|SHARE_WRITE,OPEN_EXISTING,OPEN_REPARSE|BACKUP); held.Add(dh); Validate(dh,expected,rootFinal,true); parent=dh;
+      }
+      if(parent==null) parent=rh; return held;
+    } catch { foreach(var h in held) h.Dispose(); throw; }
+  }
+  static SafeFileHandle Borrow(SafeFileHandle h){ return new SafeFileHandle(h.DangerousGetHandle(),false); }
+  static byte[] ReadBytes(SafeFileHandle h){ using(var s=new FileStream(Borrow(h),FileAccess.Read,65536,false)){ using(var m=new MemoryStream()){ s.CopyTo(m); return m.ToArray(); } } }
+  static string Hash(byte[] b){ using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-","").ToLowerInvariant(); }
+  static void CheckExpected(SafeFileHandle h,string expected){ if(expected==null || expected.Length==0) return; byte[] b=ReadBytes(h); if(!String.Equals(Hash(b),expected,StringComparison.OrdinalIgnoreCase)) throw Fail("WORKSPACE_FILE_CHANGED","file changed since read"); }
+  static void RenameHandle(SafeFileHandle source,string destination,bool replace){
+    byte[] name=System.Text.Encoding.Unicode.GetBytes(Full(destination)); int rootOffset=IntPtr.Size==8?8:4; int lengthOffset=rootOffset+IntPtr.Size; int nameOffset=lengthOffset+4;
+    IntPtr p=Marshal.AllocHGlobal(nameOffset+name.Length); try { for(int i=0;i<nameOffset+name.Length;i++) Marshal.WriteByte(p,i,0); if(replace) Marshal.WriteInt32(p,0,(int)(RENAME_REPLACE|RENAME_POSIX)); Marshal.WriteIntPtr(p,rootOffset,IntPtr.Zero); Marshal.WriteInt32(p,lengthOffset,name.Length); Marshal.Copy(name,0,IntPtr.Add(p,nameOffset),name.Length); int klass=replace?FileRenameInfoEx:FileRenameInfo; if(!SetFileInformationByHandle(source,klass,p,(uint)(nameOffset+name.Length))){ int e=Marshal.GetLastWin32Error(); throw new Win32Exception(e,"atomic handle rename failed ("+e+")"); } } finally { Marshal.FreeHGlobal(p); }
+  }
+  static void DeleteHandle(SafeFileHandle h){ var d=new FILE_DISPOSITION_INFO{DeleteFile=true}; int n=Marshal.SizeOf(d); IntPtr p=Marshal.AllocHGlobal(n); try { Marshal.StructureToPtr(d,p,false); if(!SetFileInformationByHandle(h,FileDispositionInfo,p,(uint)n)) throw new Win32Exception(Marshal.GetLastWin32Error(),"handle delete failed"); } finally { Marshal.FreeHGlobal(p); } }
+  static SafeFileHandle OpenTarget(string target,string expected,string rootFinal,uint access,uint share){ var h=OpenRaw(target,access|READ_ATTR,share,OPEN_EXISTING,OPEN_REPARSE); try { var i=Info(h); if((i.FileAttributes&ATTR_REPARSE)!=0 || (i.FileAttributes&ATTR_DIRECTORY)!=0) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","invalid file resource: "+expected); string f=Final(h); if(!Eq(f,expected) || !Under(rootFinal,f)) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","opened file path mismatch: "+f); return h; } catch { h.Dispose(); throw; } }
+  static SafeFileHandle OpenCommitted(string target,string rootFinal){ var h=OpenRaw(target,READ_ATTR,SHARE_READ|SHARE_WRITE|SHARE_DELETE,OPEN_EXISTING,OPEN_REPARSE); try { var i=Info(h); if((i.FileAttributes&ATTR_REPARSE)!=0 || (i.FileAttributes&ATTR_DIRECTORY)!=0) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","invalid committed resource"); string f=Final(h); if(!Under(rootFinal,f)) throw Fail("BUILD_PATH_UNSAFE_SYMLINK","committed resource escaped workspace: "+f); return h; } catch { h.Dispose(); throw; } }
+  static void WriteBytes(SafeFileHandle h,byte[] bytes){ using(var s=new FileStream(Borrow(h),FileAccess.ReadWrite,65536,false)){ s.Position=0; s.SetLength(0); s.Write(bytes,0,bytes.Length); s.Flush(true); } }
+
+  public static WxResult Read(string root,string target){ string rf; SafeFileHandle parent; var held=LockParents(root,target,false,out rf,out parent); try { string expected=Path.Combine(Final(parent),Path.GetFileName(target)); using(var h=OpenTarget(target,expected,rf,READ,SHARE_READ)){ byte[] b=ReadBytes(h); return new WxResult{data=Convert.ToBase64String(b),bytes=b.Length,sha256=Hash(b),path=target}; } } finally { foreach(var h in held) h.Dispose(); } }
+
+  public static WxResult Write(string root,string target,string data,string expectedHash,bool mustNotExist){
+    string rf; SafeFileHandle parent; var held=LockParents(root,target,true,out rf,out parent); string leaf=Path.GetFileName(target), expected=Path.Combine(Final(parent),leaf); SafeFileHandle file=null;
+    try {
+      byte[] bytes=Convert.FromBase64String(data);
+      try {
+        file=OpenTarget(target,expected,rf,READ|WRITE,SHARE_READ);
+        if(mustNotExist) throw Fail("WORKSPACE_FILE_EXISTS",target);
+        CheckExpected(file,expectedHash);
+        byte[] original=ReadBytes(file);
+        try { WriteBytes(file,bytes); } catch { try { WriteBytes(file,original); } catch {} throw; }
+      } catch(WxFailure e){
+        if(e.Code!="WORKSPACE_FILE_NOT_FOUND") throw;
+        if(expectedHash!=null && expectedHash.Length>0) throw Fail("WORKSPACE_FILE_CHANGED","file disappeared since read");
+        file=OpenRaw(target,READ|WRITE|DELETE,SHARE_READ,CREATE_NEW,OPEN_REPARSE|WRITE_THROUGH);
+        try { Validate(file,expected,rf,false); WriteBytes(file,bytes); } catch { try { DeleteHandle(file); } catch {} throw; }
+      }
+      return new WxResult{bytes=bytes.Length,sha256=Hash(bytes),path=target};
+    } finally { if(file!=null) file.Dispose(); foreach(var h in held) h.Dispose(); }
+  }
+
+  public static WxResult Delete(string root,string target,string expectedHash){ string rf; SafeFileHandle parent; var held=LockParents(root,target,false,out rf,out parent); try { string expected=Path.Combine(Final(parent),Path.GetFileName(target)); using(var h=OpenTarget(target,expected,rf,READ|DELETE,SHARE_READ|SHARE_DELETE)){ CheckExpected(h,expectedHash); DeleteHandle(h); return new WxResult{path=target}; } } finally { foreach(var h in held) h.Dispose(); } }
+
+  public static WxResult Move(string root,string source,string destination,string expectedHash,bool mustNotExist){
+    string srf,drf; SafeFileHandle sp,dp; var sh=LockParents(root,source,false,out srf,out sp); var dh=LockParents(root,destination,true,out drf,out dp);
+    try { string se=Path.Combine(Final(sp),Path.GetFileName(source)), de=Path.Combine(Final(dp),Path.GetFileName(destination)); using(var h=OpenTarget(source,se,srf,READ|DELETE,SHARE_READ|SHARE_DELETE)){ CheckExpected(h,expectedHash); SafeFileHandle existing=null; try { existing=OpenTarget(destination,de,drf,READ_ATTR,SHARE_READ|SHARE_WRITE|SHARE_DELETE); if(mustNotExist) throw Fail("WORKSPACE_FILE_EXISTS",destination); } catch(WxFailure e){ if(e.Code!="WORKSPACE_FILE_NOT_FOUND") throw; } finally { if(existing!=null) existing.Dispose(); } RenameHandle(h,destination,!mustNotExist); using(var committed=OpenCommitted(destination,drf)){ if(!SameIdentity(h,committed)){ try { RenameHandle(h,source,false); } catch {} throw Fail("BUILD_PATH_UNSAFE_SYMLINK","post-move file identity mismatch"); } } return new WxResult{path=destination}; } } finally { foreach(var h in dh) h.Dispose(); foreach(var h in sh) h.Dispose(); }
+  }
+}
+'@
+while(($line=[Console]::In.ReadLine()) -ne $null){
+  try { $q=$line|ConvertFrom-Json; if($q.op -eq 'read'){$v=[WxWorkspaceFs]::Read($q.root,$q.target)} elseif($q.op -eq 'write'){$v=[WxWorkspaceFs]::Write($q.root,$q.target,$q.data,$q.expectedSha256,[bool]$q.mustNotExist)} elseif($q.op -eq 'delete'){$v=[WxWorkspaceFs]::Delete($q.root,$q.target,$q.expectedSha256)} elseif($q.op -eq 'move'){$v=[WxWorkspaceFs]::Move($q.root,$q.target,$q.destination,$q.expectedSha256,[bool]$q.mustNotExist)} else { throw 'unknown operation' }; $o=@{ok=$true;value=$v} }
+  catch { $e=$_.Exception; while($e.InnerException){$e=$e.InnerException}; $code=if($e.Code){$e.Code}else{'WORKSPACE_FILE_OPERATION_FAILED'}; $o=@{ok=$false;code=$code;message=$e.Message} }
+  [Console]::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
+}
`.replace(/^\+/gm, '');

interface BrokerReply {
  ok: boolean;
  code?: WorkspaceFsErrorCode;
  message?: string;
  value?: { data?: string; bytes?: number; sha256?: string; path?: string };
}

interface BrokerState {
  process: ChildProcessWithoutNullStreams;
  lines: Interface;
  generation: number;
}

let broker: BrokerState | null = null;
let brokerGeneration = 0;
let brokerQueue: Promise<unknown> = Promise.resolve();

function resetBroker(): void {
  const current = broker;
  broker = null;
  current?.lines.close();
  try { current?.process.kill(); } catch { /* broker 已退出 */ }
}

function getBroker(): BrokerState {
  if (broker && !broker.process.killed) return broker;
  const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_BROKER], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
  const state: BrokerState = { process, lines, generation: ++brokerGeneration };
  broker = state;
  process.once('exit', () => {
    if (broker?.generation === state.generation) {
      broker.lines.close();
      broker = null;
    }
  });
  return state;
}

async function brokerRequest(request: Record<string, unknown>): Promise<BrokerReply> {
  const run = async (): Promise<BrokerReply> => {
    const active = getBroker();
    let stderr = '';
    const onStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2000); };
    active.process.stderr.on('data', onStderr);
    try {
      const reply = new Promise<BrokerReply>((resolveReply, rejectReply) => {
        let settled = false;
        const cleanup = (): void => {
          active.lines.off('line', onLine);
          active.process.off('exit', onExit);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onLine = (line: string) => settle(() => {
          try {
            const parsed = JSON.parse(line) as BrokerReply;
            if (typeof parsed.ok !== 'boolean' || (parsed.ok && parsed.value !== undefined && (typeof parsed.value !== 'object' || parsed.value === null)) || (!parsed.ok && typeof parsed.code !== 'string')) {
              rejectReply(new Error(`Invalid Windows workspace broker response shape: ${line.slice(0, 200)}`));
            } else {
              resolveReply(parsed);
            }
          } catch { rejectReply(new Error(`Invalid Windows workspace broker response: ${line.slice(0, 200)}`)); }
        });
        const onExit = (code: number | null) => settle(() => rejectReply(new Error(`Windows workspace broker exited (${code}): ${stderr}`)));
        active.lines.on('line', onLine);
        active.process.once('exit', onExit);
      });
      active.process.stdin.write(`${JSON.stringify(request)}\n`);
      return await reply;
    } finally {
      active.process.stderr.off('data', onStderr);
    }
  };
  const pending = brokerQueue.then(run, run);
  brokerQueue = pending.catch(() => undefined);
  try { return await pending; } catch (cause) { resetBroker(); throw new WorkspaceFsError('WORKSPACE_HANDLE_VERIFICATION_UNAVAILABLE', String((cause as Error).message ?? cause)); }
}

async function preflight(root: string, target: string, options?: WorkspaceOperationOptions): Promise<string> {
  const boundary = await validateWorkspaceTarget(root, target);
  if (!boundary.ok) throw new WorkspaceFsError(boundary.code, `Unsafe workspace path: ${target}`);
  await options?.afterPreflight?.();
  return boundary.target;
}

function unwrap(reply: BrokerReply): NonNullable<BrokerReply['value']> {
  if (!reply.ok) throw new WorkspaceFsError(reply.code ?? 'WORKSPACE_FILE_OPERATION_FAILED', reply.message ?? 'Workspace file operation failed');
  return reply.value ?? {};
}

async function portableRead(root: string, target: string): Promise<Buffer> {
  const handle = await open(target, 'r');
  try {
    const [handleStat, final] = await Promise.all([handle.stat(), realpath(target)]);
    const rootReal = await realpath(root);
    const rel = relative(rootReal, final);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new WorkspaceFsError('BUILD_PATH_UNSAFE_SYMLINK', `Final path escaped workspace: ${final}`);
    const finalStat = await stat(final);
    if (handleStat.dev !== finalStat.dev || handleStat.ino !== finalStat.ino) throw new WorkspaceFsError('BUILD_PATH_UNSAFE_SYMLINK', 'Opened file identity changed during validation');
    return handle.readFile();
  } finally { await handle.close(); }
}

export async function safeWorkspaceRead(root: string, target: string, options?: WorkspaceOperationOptions): Promise<Buffer> {
  const authorized = await preflight(root, target, options);
  if (process.platform !== 'win32') return portableRead(root, authorized);
  const value = unwrap(await brokerRequest({ op: 'read', root: resolve(root), target: authorized }));
  return Buffer.from(value.data ?? '', 'base64');
}

export async function safeWorkspaceWrite(root: string, target: string, data: string | Buffer, options: WorkspaceWriteOptions = {}): Promise<{ bytes: number; sha256: string }> {
  const authorized = await preflight(root, target, options);
  if (process.platform !== 'win32') throw new WorkspaceFsError('WORKSPACE_HANDLE_VERIFICATION_UNAVAILABLE', 'Atomic handle-bound workspace writes require the Windows broker');
  const value = unwrap(await brokerRequest({ op: 'write', root: resolve(root), target: authorized, data: Buffer.from(data).toString('base64'), expectedSha256: options.expectedSha256 ?? '', mustNotExist: options.mustNotExist === true }));
  return { bytes: value.bytes ?? Buffer.byteLength(data), sha256: value.sha256 ?? workspaceSha256(data) };
}

export async function safeWorkspaceDelete(root: string, target: string, options: WorkspaceWriteOptions = {}): Promise<void> {
  const authorized = await preflight(root, target, options);
  if (process.platform !== 'win32') throw new WorkspaceFsError('WORKSPACE_HANDLE_VERIFICATION_UNAVAILABLE', 'Handle-bound workspace deletes require the Windows broker');
  unwrap(await brokerRequest({ op: 'delete', root: resolve(root), target: authorized, expectedSha256: options.expectedSha256 ?? '' }));
}

export async function safeWorkspaceMove(root: string, source: string, destination: string, options: WorkspaceMoveOptions = {}): Promise<void> {
  const authorizedSource = await preflight(root, source, options);
  const authorizedDestination = await preflight(root, destination);
  if (process.platform !== 'win32') throw new WorkspaceFsError('WORKSPACE_HANDLE_VERIFICATION_UNAVAILABLE', 'Handle-bound workspace moves require the Windows broker');
  unwrap(await brokerRequest({ op: 'move', root: resolve(root), target: authorizedSource, destination: authorizedDestination, expectedSha256: options.expectedSha256 ?? '', mustNotExist: options.mustNotExist !== false }));
}

export function closeWorkspaceFsBroker(): void { resetBroker(); }
