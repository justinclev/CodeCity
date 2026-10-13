using Grpc.Net.Client;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class InvoicesController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id)
    {
        var channel = GrpcChannel.ForAddress("http://ledger:50051");
        var client = new Ledger.LedgerClient(channel);
        return Ok();
    }
}
