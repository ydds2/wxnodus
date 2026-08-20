using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WxNodus.WinUiFixture
{
    public sealed partial class MainWindow : Window
    {
        public MainWindow()
        {
            InitializeComponent();
        }

        private void Invoke_OnClick(object sender, RoutedEventArgs e)
        {
            status.Text = "invoked";
        }
    }
}
