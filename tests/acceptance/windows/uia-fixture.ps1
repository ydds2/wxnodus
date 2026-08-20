# uia-fixture.ps1 — Gate E uia scenario fixture (real WPF window: TextBox/Button/ListBox)
# WPF has first-class UIA peers: real AutomationIds, Button=InvokePattern, TextBox=ValuePattern,
# ListBoxItem=SelectionItemPattern. Driven by scripts/uia-scenario-driver.ts via the production bridge.
#   FixtureEdit   -> TextBox  (ValuePattern  - Chinese-native input)
#   FixtureButton -> Button   (InvokePattern - click handler echoes TextBox text to invoke-echo.txt)
#   FixtureList   -> ListBox  (SelectionItemPattern - handler echoes selected item to select-echo.txt)
param([string]$Out = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="WxNodus-UiaFixture" Width="420" Height="280" WindowStartupLocation="Manual" Left="60" Top="60" Topmost="True">
  <StackPanel Margin="12">
    <TextBox x:Name="FixtureEdit" AutomationProperties.AutomationId="FixtureEdit" Height="28" Margin="0,0,0,8" />
    <Button x:Name="FixtureButton" Content="FixtureButton" AutomationProperties.AutomationId="FixtureButton" Height="30" Margin="0,0,0,8" />
    <ListBox x:Name="FixtureList" AutomationProperties.AutomationId="FixtureList" Height="110">
      <ListBoxItem Content="Alpha" AutomationProperties.AutomationId="ItemAlpha" />
      <ListBoxItem Content="Beta" AutomationProperties.AutomationId="ItemBeta" />
      <ListBoxItem Content="Gamma" AutomationProperties.AutomationId="ItemGamma" />
    </ListBox>
  </StackPanel>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [System.Windows.Markup.XamlReader]::Load($reader)

$echoDir = if ($Out -ne '') { $Out } else { Join-Path ([System.IO.Path]::GetTempPath()) 'wxnodus-uia-echo' }
[void](New-Item -ItemType Directory -Force -Path $echoDir -ErrorAction SilentlyContinue)

$edit = $window.FindName('FixtureEdit')
$btn = $window.FindName('FixtureButton')
$list = $window.FindName('FixtureList')

$btn.Add_Click({
  [System.IO.File]::WriteAllText((Join-Path $echoDir 'invoke-echo.txt'), $edit.Text)
})
$list.Add_SelectionChanged({
  if ($null -ne $list.SelectedItem) {
    [System.IO.File]::WriteAllText((Join-Path $echoDir 'select-echo.txt'), [string]$list.SelectedItem.Content)
  }
})

[void]$window.ShowDialog()
