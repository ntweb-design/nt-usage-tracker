# Prints, base64-encoded, the secret of a generic credential in the Windows
# Credential Manager for the current user. Nothing is printed when it is absent.
# Read-only: used to borrow the sign-in the Antigravity CLI (agy) keeps there.
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace NTUsage -Name Vault -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
public static byte[] Read(string target) {
  IntPtr p;
  if (!CredReadW(target, 1, 0, out p)) return null;
  try {
    var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    var b = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
    return b;
  } finally { CredFree(p); }
}
'@
$bytes = [NTUsage.Vault]::Read($Target)
if ($bytes) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }
