using System.Windows;

namespace WxNodus.WpfFixture
{
    public partial class MainWindow : Window
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
